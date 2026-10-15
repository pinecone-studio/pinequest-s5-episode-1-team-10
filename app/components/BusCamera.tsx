"use client";

// Camera step: YOLO finds buses on the phone, each bus is tracked, its sign is read on the phone,
// and two agreeing reads from different frames decide. One read never does.
// Detection runs every frame and never waits for the sign reader, which works on a snapshot in a worker.
// Once it's the rider's bus, the camera keeps following that bus and guides them to its front door:
// a beacon panned toward the door, clock direction + steps, "bus moving, step back".
import { useEffect, useRef, type MutableRefObject } from "react";
import { verifySign, verifyTexts } from "../lib/api";
import { decideSign, routeNumber } from "../lib/fusion";
import { cityNumbers, prefetchStopRoutes, routesFor } from "../lib/stopRoutes";
import { aimBeacon, startBeacon, stopBeacon } from "../lib/beacon";
import { MIN_BUS_WIDTH, signCanvas, signCrop, signScore } from "../lib/crop";
import { loadOcr, readSign } from "../lib/ocr";
import { detectBuses, loadDetector, type Box } from "../lib/detector";
import { detectFrontDoor, loadDoorDetector } from "../lib/doorDetector";
import { frontIsRight, guideToDoor, type DoorGuide } from "../lib/door";
import { isIOS } from "../lib/device";
import { explainPermission } from "../lib/permissions";
import { cue, phrase, vibrate, type PhraseKey } from "../lib/speech";
import { addVote, updateTracks, VOTE_WINDOW, type Track } from "../lib/tracker";
import { markDecided } from "../lib/latency";

interface Props {
  stopId: string;
  route: string;
  foundSpeech: string;
  onFound: () => void;
  onError: () => void;
  guide: MutableRefObject<DoorGuide | null>; // latest door guidance, for the "where is the door?" option
  phoneOcr: boolean; // the server has no OCR (free hosting): read the sign on the phone, send only the texts
  onAnnounce: (texts: string[]) => Promise<void>; // status text and speech, so a hint is never only spoken
  screenReader: boolean; // door-close sentence names the button instead of a double tap
}

const GUIDE_EVERY_MS = 4000; // repeat "door at 2 o'clock, 9 steps" this often
const LOST_AFTER_MS = 2000;
const MOVING = 0.00015; // bus box moving faster than 15% of its length per second = bus is moving
const DOOR_EVERY_MS = 150; // door model runs at most this often (it's 4x the bus model's size)
const DOOR_KEEP_MS = 2000; // a door seen this recently still counts (it moves with the bus box)

// "Хаалга 2 цагийн зүгт. 9 алхам." from pre-made clips.
export function doorSpeech(g: DoorGuide, screenReader?: boolean): string[] {
  if (g.close) {
    return [phrase(screenReader ? "door_close_sr" : "door_close")];
  }
  if (g.ahead) {
    return [phrase("door_ahead"), phrase(("steps_" + g.steps) as PhraseKey)];
  }
  return [phrase(("clock_" + g.clock) as PhraseKey), phrase(("steps_" + g.steps) as PhraseKey)];
}

const ASK_EVERY_MS = 250; // per bus, between /verify requests
const MAX_PENDING = 1; // /verify requests in flight at once: the server reads one sign at a time
const NO_ANSWER_MS = 5000; // bus in view this long with no /verify answer -> "not sure"
const REPEAT_AFTER_MS = 5000; // don't repeat "bus seen" / "not your bus" more often than this
// Guidance while looking for the bus, so the rider is never left in silence: what the camera sees and
// what to do about it. One hint at a time, never over other speech.
const LOADING_SAY_MS = 2500; // models still loading after this: "getting ready"
const NO_BUS_MS = 8000; // nothing in view this long: "no bus, keep pointing at the road"
const READ_HARD_MS = 6000; // a near bus read this long without any answer: "point at its front"
const EDGE = 0.02; // a bus box this close to the frame edge is cut off

const COLORS: Record<string, string> = { checking: "#ffd400", yes: "#00e676", no: "#ff1744", unsure: "#ff9100" };
const LABELS: Record<string, string> = { checking: "Шалгаж байна", yes: "ТАНЫ АВТОБУС", no: "Биш", unsure: "Итгэлгүй" };

// A still photo as a camera-like stream, so detection and cropping run exactly as on the camera.
function photoStream(url: string): Promise<MediaStream> {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      const stream = canvas.captureStream(10);
      const track = stream.getVideoTracks()[0];
      // A canvas stream only emits frames when it's drawn on; stops once the camera step stops the track.
      const timer = setInterval(function () {
        if (track.readyState === "ended") {
          clearInterval(timer);
        } else {
          ctx.drawImage(img, 0, 0);
        }
      }, 100);
      ctx.drawImage(img, 0, 0);
      resolve(stream);
    };
    img.onerror = reject;
    img.src = url;
  });
}

function draw(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  tracks: Track[],
  target: Track | null,
  door: DoorGuide | null,
  doorBox: Box | null,
): void {
  // Sized only when the video size changes: re-sizing a 1080p canvas every frame re-allocated ~8 MB
  // 10-40 times a second, and iPhone Safari reloads a page whose canvas memory runs over its limit.
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 6;
  ctx.font = "bold 32px sans-serif";
  tracks.forEach(function (item) {
    const color = COLORS[item.decision];
    const b = item.box;
    ctx.strokeStyle = color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = color;
    ctx.fillText(LABELS[item.decision] + " " + item.votes.length + "/" + VOTE_WINDOW, b.x + 8, Math.max(36, b.y - 10));
  });
  if (target && door) {
    const b = target.box;
    ctx.strokeStyle = "#00e676";
    ctx.lineWidth = 10;
    if (doorBox) {
      // The front door the model found.
      ctx.strokeRect(doorBox.x, doorBox.y, doorBox.w, doorBox.h);
    } else {
      // Geometry guess: a line where the front door should be.
      ctx.setLineDash([24, 16]);
      ctx.beginPath();
      ctx.moveTo(door.x, b.y + b.h * 0.25);
      ctx.lineTo(door.x, b.y + b.h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#00e676";
    ctx.font = "bold 40px sans-serif";
    const label = door.ahead ? "ХААЛГА ↑" : "ХААЛГА " + door.clock + " цаг";
    ctx.fillText(label + " · " + door.steps + " алхам", Math.max(8, Math.min(door.x - 200, canvas.width - 520)), b.y + b.h + 48);
  }
}

// What the camera step is doing, for whoever helps debug on a phone (?debug=1 shows it on screen;
// tests read window.__cam).
interface CamStats {
  stage: string;
  provider: string;
  video: string;
  frames: number;
  fps: number;
  buses: number;
  widest: number;
  reads: number;
  lastText: string;
  error: string;
  detectMs: number;
  ocrMs: number;
  decideMs: number; // first frame of the confirmed bus -> "yes"
}

export default function BusCamera({ stopId, route, foundSpeech, onFound, onError, guide, phoneOcr, onAnnounce, screenReader }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const debugRef = useRef<HTMLParagraphElement>(null);
  const announceRef = useRef(onAnnounce);
  useEffect(function () {
    announceRef.current = onAnnounce;
  });

  useEffect(
    function () {
      let stopped = false;
      let stream: MediaStream | null = null;
      let tracks: Track[] = [];
      let pending = 0;
      let ocrWorker: Worker | null = null;
      let workerReady = false;
      // iPhone: the sign is read on the detector's runtime. A second one is another 256 MB and Safari kills the tab.
      const phoneReadsHere = phoneOcr && isIOS();
      const flying = new Set<number>();
      const held = new Map<number, { score: number; frame: number; width: number; height: number; pixels: Uint8ClampedArray }>();
      let lastSeenSpoken = 0;
      let lastNoSpoken = 0;
      let target: Track | null = null; // the rider's bus, once confirmed
      let foundAt = 0;
      let talking = false;
      let lastGuideSpoken = 0;
      let lastMovingSpoken = 0;
      let lastLostSpoken = 0;
      let lastAheadBuzz = 0;
      let closeSaid = false;
      const openedAt = performance.now(); // for the "[bus] yes after N ms" log (speed checks)
      const frameTimes = new Map<number, number>(); // frame number -> when it was taken (lib/latency.ts)
      let doorFromFront: number | null = null; // smoothed door-model position, share of the bus length
      let doorSeenAt = 0;
      let doorBox: Box | null = null;
      let lastDoorRun = 0;
      const stats: CamStats = { stage: "starting", provider: "", video: "", frames: 0, fps: 0, buses: 0, widest: 0, reads: 0, lastText: "", error: "", detectMs: 0, ocrMs: 0, decideMs: 0 };
      (window as unknown as { __cam: CamStats }).__cam = stats;
      let fpsFrom = performance.now();
      let fpsFrames = 0;
      const debugTimer = setInterval(function () {
        if (debugRef.current) {
          debugRef.current.textContent =
            stats.stage + " · " + stats.provider + " · " + stats.video + " · " + stats.fps + " fps · buses " + stats.buses + " (widest " + stats.widest + " px) · reads " + stats.reads + (stats.lastText ? " «" + stats.lastText + "»" : "") + " · detect " + stats.detectMs + " ms · ocr " + stats.ocrMs + " ms · decide " + stats.decideMs + " ms" + (stats.error ? " · ERROR " + stats.error : "");
        }
      }, 500);

      function speak(texts: string[]): void {
        talking = true;
        announceRef.current(texts).then(function () {
          talking = false;
        });
      }

      let lastHint = 0;
      let scanningSince = 0;
      let lastBusAt = 0;
      let readingSince = 0;
      function hint(key: PhraseKey, every: number): void {
        const now = performance.now();
        if (talking || now - lastHint < every) {
          return;
        }
        lastHint = now;
        speak([phrase(key)]);
      }

      // Before the bus is confirmed: say what the camera sees and what to do.
      function guideSearch(video: HTMLVideoElement, buses: Box[], near: Track[], now: number): void {
        if (buses.length) {
          lastBusAt = now;
        }
        if (!near.length) {
          readingSince = 0;
        } else if (!readingSince) {
          readingSince = now;
        }
        if (!buses.length) {
          if (now - Math.max(scanningSince, lastBusAt) > NO_BUS_MS) {
            hint("no_bus_yet", 12000);
          }
          return;
        }
        if (!near.length) {
          hint("bus_far", 10000); // seen, but too small to read yet
          return;
        }
        const b = near[0].box; // the closest bus
        const cutLeft = b.x <= video.videoWidth * EDGE;
        const cutRight = b.x + b.w >= video.videoWidth * (1 - EDGE);
        if (cutLeft && !cutRight) {
          hint("bus_left", 6000);
        } else if (cutRight && !cutLeft) {
          hint("bus_right", 6000);
        } else if (now - readingSince > READ_HARD_MS && near.every(function (item) {
          return item.decision === "checking";
        })) {
          hint("sign_hard", 10000);
        }
      }

      // Door guidance for the confirmed bus, every frame.
      function guideDoor(video: HTMLVideoElement, now: number): DoorGuide | null {
        const bus = target as Track;
        if (now - bus.lastSeen > LOST_AFTER_MS) {
          guide.current = null;
          aimBeacon(90); // slow blips: no door in view
          if (now - lastLostSpoken > GUIDE_EVERY_MS * 1.5) {
            lastLostSpoken = now;
            speak([phrase("door_lost")]);
          }
          return null;
        }
        const recent = now - doorSeenAt < DOOR_KEEP_MS;
        if (!recent) {
          doorBox = null;
        }
        const g = guideToDoor(bus.box, video.videoWidth, video.videoHeight, frontIsRight(bus.vx, bus.box), recent ? doorFromFront : null);
        guide.current = g;
        aimBeacon(g.angle);
        // Safety first: a moving bus overrides everything else.
        if (now - foundAt > 1500 && Math.abs(bus.vx) > bus.box.w * MOVING) {
          if (now - lastMovingSpoken > GUIDE_EVERY_MS) {
            lastMovingSpoken = now;
            vibrate([200, 100, 200, 100, 200]);
            speak([phrase("bus_moving")]);
          }
          return g;
        }
        if (g.close && !closeSaid) {
          closeSaid = true;
          vibrate([300, 100, 300]);
          speak(doorSpeech(g, screenReader));
        } else if (!talking && now - lastGuideSpoken > GUIDE_EVERY_MS) {
          lastGuideSpoken = now;
          speak(doorSpeech(g, screenReader));
        }
        if (g.ahead && now - lastAheadBuzz > 1000) {
          lastAheadBuzz = now;
          vibrate([30]);
        }
        return g;
      }

      // Door model on the front end of the confirmed bus; its position is kept relative to the bus
      // box (smoothed), so the beacon follows the door as the bus or the phone moves.
      async function findDoor(video: HTMLVideoElement, bus: Track, now: number): Promise<void> {
        const frontRight = frontIsRight(bus.vx, bus.box);
        const box = await detectFrontDoor(video, bus.box, frontRight);
        if (!box) {
          return;
        }
        const centre = box.x + box.w / 2;
        const rel = Math.abs((frontRight ? bus.box.x + bus.box.w : bus.box.x) - centre) / bus.box.w;
        doorFromFront = doorFromFront === null || now - doorSeenAt > DOOR_KEEP_MS ? rel : 0.6 * doorFromFront + 0.4 * rel;
        doorSeenAt = now;
        doorBox = box;
      }

      function announce(track: Track): void {
        const now = performance.now();
        if (track.decision === track.announced) {
          return;
        }
        track.announced = track.decision;
        if (track.decision === "yes") {
          if (target) {
            return;
          }
          target = track; // keep following this bus to its door
          loadDoorDetector(); // already loaded with WebGPU; on CPU it starts now (geometry until it's ready)
          foundAt = now;
          stats.decideMs = Math.round(now - track.seenAt);
          console.info("[bus] yes after " + Math.round(now - openedAt) + " ms from camera open, " + stats.decideMs + " ms from first sight, " + track.votes.length + " reads");
          const lastRead = track.reads.length ? track.reads[track.reads.length - 1].frame : -1;
          markDecided("bus camera", now, frameTimes.get(lastRead) ?? null);
          lastGuideSpoken = now; // the intro below already guides; first clock direction comes after it
          cue("bus", [400, 100, 400]);
          // The side is known only once the bus is moving. Standing still used to say "on your right".
          let intro: PhraseKey = "door_intro_plain";
          if (Math.abs(track.vx) > track.box.w * 0.0002) {
            intro = track.vx > 0 ? "door_intro_right" : "door_intro_left";
          }
          speak([foundSpeech, phrase(intro)]);
          startBeacon();
          onFound();
        } else if (track.decision === "no" && now - lastNoSpoken > REPEAT_AFTER_MS) {
          lastNoSpoken = now;
          vibrate([100, 80, 100]);
          speak([phrase("not_your_bus")]);
        } else if (track.decision === "unsure") {
          speak([phrase("not_sure")]);
        }
      }

      // A box that suddenly shrinks or stretches is probably a person in front of the bus, not a new sign.
      function steady(track: Track): boolean {
        const aspect = track.box.w / Math.max(1, track.box.h);
        if (track.samples.length >= 3) {
          let sumW = 0;
          track.samples.forEach(function (item) {
            sumW += item;
          });
          let sumA = 0;
          track.aspects.forEach(function (item) {
            sumA += item;
          });
          const avgW = sumW / track.samples.length;
          const avgA = sumA / track.aspects.length;
          if (avgW > 0 && Math.abs(track.box.w - avgW) / avgW > 0.25) {
            return false;
          }
          if (avgA > 0 && Math.abs(aspect - avgA) / avgA > 0.25) {
            return false;
          }
        }
        track.samples = track.samples.concat(track.box.w).slice(-8);
        track.aspects = track.aspects.concat(aspect).slice(-8);
        return true;
      }

      function dispatch(id: number): void {
        const job = held.get(id);
        if (!ocrWorker || !workerReady || flying.has(id) || !job) {
          return;
        }
        held.delete(id);
        flying.add(id);
        const pixels = job.pixels.buffer as ArrayBuffer;
        ocrWorker.postMessage({ type: "read", trackId: id, frame: job.frame, width: job.width, height: job.height, pixels: pixels }, [pixels]);
      }

      function onOcr(e: MessageEvent): void {
        const data = e.data as { type: string; ok?: boolean; trackId?: number; frame?: number; texts?: [string, number][]; ms?: number };
        if (data.type === "ready") {
          workerReady = !!data.ok;
          if (!workerReady) {
            stats.error = "sign reader not loaded";
            if (!stopped) {
              speak([phrase("ocr_failed")]);
            }
            return;
          }
          Array.from(held.keys()).forEach(function (item) {
            dispatch(item);
          });
          return;
        }
        if (data.type !== "read" || data.trackId === undefined || data.frame === undefined) {
          return;
        }
        flying.delete(data.trackId);
        stats.ocrMs = data.ms ?? 0;
        const texts = data.texts ?? [];
        stats.reads++;
        stats.lastText = texts
          .map(function (item) {
            return item[0];
          })
          .join(" ")
          .slice(0, 40);
        const track = tracks.find(function (item) {
          return item.id === data.trackId;
        });
        if (!track || stopped || target || track.locked || track.decision === "yes" || track.decision === "no") {
          return;
        }
        dispatch(data.trackId);
        track.lastAnswer = performance.now();
        // The verdict is decided here. The server is told only so the read is logged.
        const decided = decideSign(texts, route, routesFor(stopId), cityNumbers());
        verifyTexts(texts, stopId, route);
        addVote(track, decided.verdict, decided.confidence, decided.number, data.frame);
        announce(track);
      }

      // Full-resolution sign crop. The best (bright, complete, sharp) frame is the one the worker reads.
      function keepCrop(video: HTMLVideoElement, track: Track, now: number, others: Box[], frame: number): void {
        if (track.locked || track.decision === "no" || !steady(track)) {
          return;
        }
        if (phoneReadsHere) {
          if (flying.has(track.id)) {
            return;
          }
          const masked = others.concat(
            tracks
              .filter(function (item) {
                return item !== track && item.lastSeen === now;
              })
              .map(function (item) {
                return item.box;
              }),
          );
          const canvas = signCanvas(video, track.box, masked);
          if (!canvas) {
            return;
          }
          flying.add(track.id);
          const id = track.id;
          const readAt = performance.now();
          readSign(canvas).then(function (texts) {
            flying.delete(id);
            stats.ocrMs = Math.round(performance.now() - readAt);
            const found = tracks.find(function (item) {
              return item.id === id;
            });
            if (!found || stopped || target || found.locked || found.decision === "yes" || found.decision === "no") {
              return;
            }
            stats.reads++;
            stats.lastText = texts
              .map(function (item) {
                return item[0];
              })
              .join(" ")
              .slice(0, 40);
            found.lastAnswer = performance.now();
            const decided = decideSign(texts, route, routesFor(stopId), cityNumbers());
            verifyTexts(texts, stopId, route);
            addVote(found, decided.verdict, decided.confidence, decided.number, frame);
            announce(found);
          });
          return;
        }
        const masked = others.concat(
          tracks
            .filter(function (item) {
              return item !== track && item.lastSeen === now;
            })
            .map(function (item) {
              return item.box;
            }),
        );
        const canvas = signCanvas(video, track.box, masked);
        if (!canvas) {
          return;
        }
        const score = signScore(canvas, track.box);
        const prev = held.get(track.id);
        if (prev && prev.score >= score) {
          return;
        }
        const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
        held.set(track.id, {
          score: score,
          frame: frame,
          width: canvas.width,
          height: canvas.height,
          pixels: new Uint8ClampedArray(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
        });
        dispatch(track.id);
      }

      function ask(video: HTMLVideoElement, track: Track, now: number, others: Box[], frame: number): void {
        // Other tracked buses are masked too, not only the weak detections.
        const masked = others.concat(
          tracks
            .filter(function (item) {
              return item !== track && item.lastSeen === now;
            })
            .map(function (item) {
              return item.box;
            }),
        );
        const crop = signCrop(video, track.box, masked);
        if (!crop) {
          return;
        }
        const answer = verifySign({ sign_crop: crop, stop_id: stopId, wanted_route: route }).then(function (res) {
          if (!res) {
            return null;
          }
          return { verdict: res.verdict, confidence: res.confidence, eta_seconds: res.eta_seconds, number: res.verdict === "yes" ? routeNumber(route) : null, frame: frame };
        });
        track.pending = true;
        track.lastAsked = now;
        pending++;
        answer.then(function (res) {
          track.pending = false;
          pending--;
          if (stopped) {
            return;
          }
          if (!res) {
            // No answer in time: not a vote. If a bus stays in view with no answers at all, say so.
            if (performance.now() - track.lastAnswer > NO_ANSWER_MS && track.announced === "checking") {
              track.announced = "unsure";
              speak([phrase("not_sure")]);
            }
            return;
          }
          track.lastAnswer = performance.now();
          addVote(track, res.verdict, res.confidence, res.number, res.frame);
          announce(track);
        });
      }

      async function tick(): Promise<void> {
        const video = videoRef.current;
        const overlay = overlayRef.current;
        if (stopped || !video || !overlay) {
          return;
        }
        const detectAt = performance.now();
        const found = await detectBuses(video);
        stats.detectMs = Math.round(performance.now() - detectAt);
        if (stopped) {
          return;
        }
        const now = performance.now();
        stats.frames++;
        frameTimes.set(stats.frames, performance.now());
        frameTimes.delete(stats.frames - 300); // the deciding read is from a recent frame
        fpsFrames++;
        if (now - fpsFrom > 2000) {
          stats.fps = Math.round((fpsFrames * 10000) / (now - fpsFrom)) / 10;
          fpsFrom = now;
          fpsFrames = 0;
        }
        stats.buses = found.buses.length;
        stats.widest = Math.round(
          found.buses.reduce(function (w, item) {
            return Math.max(w, item.w);
          }, 0),
        );
        stats.video = video.videoWidth + "x" + video.videoHeight;
        tracks = updateTracks(tracks, found.buses, now);
        if (target) {
          // The bus is confirmed: only the door matters now (no more sign reading).
          if (target.lastSeen === now && now - lastDoorRun >= DOOR_EVERY_MS) {
            lastDoorRun = now;
            await findDoor(video, target, now);
            if (stopped) {
              return;
            }
          }
          draw(overlay, video, tracks, target, guideDoor(video, now), doorBox);
          requestNext();
          return;
        }
        const near = tracks.filter(function (item) {
          return item.lastSeen === now && item.box.w >= MIN_BUS_WIDTH;
        });
        if (near.length && now - lastSeenSpoken > REPEAT_AFTER_MS * 2) {
          lastSeenSpoken = now;
          lastHint = now;
          speak([phrase("bus_seen")]);
        }
        near
          .sort(function (a, b) {
            return b.box.w - a.box.w; // closest bus first
          })
          .forEach(function (item) {
            if (phoneOcr) {
              keepCrop(video, item, now, found.others, stats.frames);
            } else if (!item.pending && pending < MAX_PENDING && now - item.lastAsked >= ASK_EVERY_MS) {
              ask(video, item, now, found.others, stats.frames);
            }
          });
        const live = new Set(
          tracks.map(function (item) {
            return item.id;
          }),
        );
        Array.from(held.keys()).forEach(function (item) {
          const track = tracks.find(function (row) {
            return row.id === item;
          });
          if (!live.has(item) || !track || track.decision === "no" || track.decision === "yes") {
            held.delete(item);
            return;
          }
          dispatch(item);
        });
        guideSearch(video, found.buses, near, now);
        draw(overlay, video, tracks, null, null, null);
        requestNext();
      }

      function requestNext(): void {
        // Browsers pause animation frames in hidden tabs; keep going (slowly) for desktop testing.
        if (document.hidden) {
          setTimeout(tick, 100);
        } else {
          requestAnimationFrame(tick);
        }
      }

      // ?video=/test/bus.webm plays a recorded clip instead of the camera (testing, demo video);
      // ?image=/test/tov_nomyn_san_1.png shows a still photo as if the camera were pointed at it.
      const params = new URLSearchParams(window.location.search);
      const recorded = params.get("video");
      const photo = params.get("image");
      function openStream(): Promise<MediaStream | null> {
        if (photo) {
          return photoStream(photo);
        }
        if (recorded) {
          return Promise.resolve(null);
        }
        return navigator.mediaDevices.getUserMedia({
          // 1080p: the route number on an LED sign is a few dozen pixels; more pixels, further away.
          // iPhone: 720p (Safari reloads the page when the camera step uses too much memory; 720p
          // still reads the sign since each word is read on its own, lib/ocr.ts).
          video: isIOS()
            ? { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
            : { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      }

      // #2 Back from a locked screen / a call / another app: iPhone stops the camera while the page is
      // hidden. Start it again if it stopped, and tell the rider the camera is looking again.
      let hiddenAt = 0;
      async function onVisibility(): Promise<void> {
        if (document.visibilityState === "hidden") {
          hiddenAt = performance.now();
          return;
        }
        const away = hiddenAt ? performance.now() - hiddenAt : 0;
        hiddenAt = 0;
        const video = videoRef.current;
        if (stopped || !video || away < 2000) {
          return;
        }
        const track = stream ? stream.getVideoTracks()[0] : null;
        if (stream && (!track || track.readyState === "ended" || track.muted || video.paused)) {
          try {
            const fresh = await openStream();
            if (stopped) {
              if (fresh) {
                fresh.getTracks().forEach(function (item) {
                  item.stop();
                });
              }
              return;
            }
            stream.getTracks().forEach(function (item) {
              item.stop();
            });
            stream = fresh;
            video.srcObject = fresh;
          } catch (e) {
            stats.error = "camera restart " + (e instanceof Error ? e.name : "");
          }
        }
        video.play().catch(function () {});
        // Bus already confirmed: the door directions follow by themselves; else: looking again.
        speak([target ? phrase("app_resumed") : phrase("camera_resumed")]);
      }
      document.addEventListener("visibilitychange", onVisibility);

      async function start(): Promise<void> {
        if (!photo && !recorded) {
          await explainPermission("camera"); // the first time the phone asks for the camera
        }
        // While the phone's camera box waits for an answer, repeat what to press (a blind rider may
        // not find it at once; nothing else happens until it's answered).
        const askAgain = setInterval(function () {
          if (!stopped) {
            speak([phrase("camera_permission")]);
          }
        }, 15000);
        try {
          stream = await openStream().finally(function () {
            clearInterval(askAgain);
          });
        } catch (e) {
          stats.error = "camera " + (e instanceof Error ? e.name : "");
          speak([phrase("camera_failed")]);
          onError();
          return;
        }
        const video = videoRef.current;
        if (stopped || !video) {
          return;
        }
        if (stream) {
          video.srcObject = stream;
        } else {
          video.src = recorded as string;
          video.loop = true;
        }
        try {
          await video.play();
        } catch (e) {
          if (stopped) {
            return; // unmounted while starting (React runs effects twice in dev)
          }
          // iPhone can refuse to start the video outside a touch: start it on the rider's next one.
          stats.error = "play " + (e instanceof Error ? e.name : "");
          speak([phrase("camera_tap")]);
          const v = video;
          await new Promise<void>(function (resolve) {
            function retry(): void {
              if (stopped) {
                document.removeEventListener("pointerup", retry, true);
                resolve();
                return;
              }
              v.play()
                .then(function () {
                  document.removeEventListener("pointerup", retry, true);
                  stats.error = "";
                  resolve();
                })
                .catch(function () {});
            }
            document.addEventListener("pointerup", retry, true);
          });
        }
        if (stopped) {
          return;
        }
        speak([phrase("camera_on")]);
        stats.stage = "loading";
        // Models still loading (first time: ~25 MB): say so, so the rider knows to wait.
        let loadingSaid = false;
        const loadingTimer = setInterval(function () {
          loadingSaid = true;
          if (!talking) {
            speak([phrase("camera_loading")]);
          }
        }, 10000);
        const firstLoadingSay = setTimeout(function () {
          loadingSaid = true;
          speak([phrase("camera_loading")]);
        }, LOADING_SAY_MS);
        let provider = "";
        if (phoneOcr) {
          // The plan step already asked. Ask again in case this stop was not cached yet.
          if (!routesFor(stopId)) {
            prefetchStopRoutes(stopId, [], "");
          }
          if (!phoneReadsHere) {
            try {
              ocrWorker = new Worker("/bus-ocr-worker.js");
              ocrWorker.onmessage = onOcr;
              ocrWorker.postMessage({ type: "load" });
            } catch (e) {
              stats.error = "sign reader " + (e instanceof Error ? e.message : String(e));
              if (!stopped) {
                speak([phrase("ocr_failed")]);
              }
            }
          }
        }
        try {
          provider = await loadDetector();
          if (phoneReadsHere) {
            loadOcr();
          }
        } catch (e) {
          clearInterval(loadingTimer);
          clearTimeout(firstLoadingSay);
          stats.error = "detector " + (e instanceof Error ? e.message : String(e));
          if (!stopped) {
            speak([phrase("camera_failed")]);
            onError();
          }
          return;
        }
        clearInterval(loadingTimer);
        clearTimeout(firstLoadingSay);
        if (stopped) {
          return;
        }
        stats.provider = provider;
        stats.stage = "looking";
        scanningSince = performance.now();
        if (loadingSaid) {
          speak([phrase("camera_ready")]);
        }
        // Door model in the background, needed only once the bus is found. Without WebGPU both models
        // share one CPU queue, so it waits for the "yes" instead of slowing the sign reading.
        if (provider === "webgpu") {
          loadDoorDetector();
        }
        tick();
      }

      start();
      return function () {
        stopped = true;
        if (ocrWorker) {
          ocrWorker.terminate();
        }
        document.removeEventListener("visibilitychange", onVisibility);
        clearInterval(debugTimer);
        stopBeacon();
        guide.current = null;
        if (stream) {
          stream.getTracks().forEach(function (item) {
            item.stop();
          });
        }
      };
    },
    [stopId, route, foundSpeech, onFound, onError, guide, phoneOcr, screenReader],
  );

  return (
    <div className="camera">
      <video ref={videoRef} playsInline muted className="camera-video" aria-hidden="true" />
      <canvas ref={overlayRef} className="camera-overlay" aria-hidden="true" />
      {typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug") && <p ref={debugRef} className="camera-debug" />}
    </div>
  );
}
