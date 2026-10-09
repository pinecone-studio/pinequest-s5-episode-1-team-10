"use client";

// Camera step: YOLO finds buses on the phone, each bus is tracked, its sign crop goes to
// /verify (PaddleOCR + Hamuga on the server), and 5 of the last 7 answers must agree.
// Once it's the rider's bus, the camera keeps following that bus and guides them to its front door:
// a beacon panned toward the door, clock direction + steps, "bus moving, step back".
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Verdict } from "../../shared/contract";
import { verifySign } from "../lib/api";
import { aimBeacon, startBeacon, stopBeacon } from "../lib/beacon";
import { MIN_BUS_WIDTH, signCrop } from "../lib/crop";
import { detectBuses, loadDetector, type Box } from "../lib/detector";
import { frontIsRight, guideToDoor, type DoorGuide } from "../lib/door";
import { phrase, say, sayPhrase, vibrate, type PhraseKey } from "../lib/speech";
import { addVote, updateTracks, VOTE_WINDOW, type Track } from "../lib/tracker";

interface Props {
  stopId: string;
  route: string;
  foundSpeech: string;
  onFound: () => void;
  onError: () => void;
  guide: MutableRefObject<DoorGuide | null>; // latest door guidance, for the "where is the door?" option
}

const GUIDE_EVERY_MS = 4000; // repeat "door at 2 o'clock, 9 steps" this often
const LOST_AFTER_MS = 2000;
const MOVING = 0.00015; // bus box moving faster than 15% of its length per second = bus is moving

// "Хаалга 2 цагийн зүгт. 9 алхам." from pre-made clips.
export function doorSpeech(g: DoorGuide): string[] {
  if (g.close) {
    return [phrase("door_close")];
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
): void {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
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
    ctx.beginPath();
    ctx.moveTo(door.x, b.y + b.h * 0.25);
    ctx.lineTo(door.x, b.y + b.h);
    ctx.stroke();
    ctx.fillStyle = "#00e676";
    ctx.font = "bold 40px sans-serif";
    const label = door.ahead ? "ХААЛГА ↑" : "ХААЛГА " + door.clock + " цаг";
    ctx.fillText(label + " · " + door.steps + " алхам", Math.max(8, Math.min(door.x - 200, canvas.width - 520)), b.y + b.h + 48);
  }
}

export default function BusCamera({ stopId, route, foundSpeech, onFound, onError, guide }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("Камер асааж байна…");
  const [fps, setFps] = useState(0);

  useEffect(
    function () {
      let stopped = false;
      let stream: MediaStream | null = null;
      let tracks: Track[] = [];
      let pending = 0;
      let lastSeenSpoken = 0;
      let lastNoSpoken = 0;
      let frames = 0;
      let fpsStart = performance.now();
      let target: Track | null = null; // the rider's bus, once confirmed
      let foundAt = 0;
      let talking = false;
      let lastGuideSpoken = 0;
      let lastMovingSpoken = 0;
      let lastLostSpoken = 0;
      let lastAheadBuzz = 0;
      let closeSaid = false;

      function speak(texts: string[]): void {
        talking = true;
        say(texts).then(function () {
          talking = false;
        });
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
        const g = guideToDoor(bus.box, video.videoWidth, frontIsRight(bus.vx, bus.box));
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
          speak(doorSpeech(g));
        } else if (!talking && now - lastGuideSpoken > GUIDE_EVERY_MS) {
          lastGuideSpoken = now;
          speak(doorSpeech(g));
        }
        if (g.ahead && now - lastAheadBuzz > 1000) {
          lastAheadBuzz = now;
          vibrate([30]);
        }
        return g;
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
          foundAt = now;
          lastGuideSpoken = now; // the intro below already guides; first clock direction comes after it
          vibrate([400, 100, 400]);
          speak([foundSpeech, phrase("door_intro")]);
          startBeacon();
          onFound();
        } else if (track.decision === "no" && now - lastNoSpoken > REPEAT_AFTER_MS) {
          lastNoSpoken = now;
          vibrate([100, 80, 100]);
          sayPhrase("not_your_bus");
        } else if (track.decision === "unsure") {
          sayPhrase("not_sure");
        }
      }

      function ask(video: HTMLVideoElement, track: Track, now: number, others: Box[]): void {
        // Other tracked buses are masked too, not only the weak detections.
        const crop = signCrop(
          video,
          track.box,
          others.concat(
            tracks
              .filter(function (item) {
                return item !== track && item.lastSeen === now;
              })
              .map(function (item) {
                return item.box;
              }),
          ),
        );
        if (!crop) {
          return;
        }
        track.pending = true;
        track.lastAsked = now;
        pending++;
        verifySign({ sign_crop: crop, stop_id: stopId, wanted_route: route }).then(function (res) {
          track.pending = false;
          pending--;
          if (stopped) {
            return;
          }
          if (!res) {
            // No answer in time: not a vote. If a bus stays in view with no answers at all, say so.
            if (performance.now() - track.lastAnswer > NO_ANSWER_MS && track.announced === "checking") {
              track.announced = "unsure";
              sayPhrase("not_sure");
            }
            return;
          }
          track.lastAnswer = performance.now();
          addVote(track, res.verdict as Verdict);
          announce(track);
        });
      }

      async function tick(): Promise<void> {
        const video = videoRef.current;
        const overlay = overlayRef.current;
        if (stopped || !video || !overlay) {
          return;
        }
        const found = await detectBuses(video);
        if (stopped) {
          return;
        }
        const now = performance.now();
        tracks = updateTracks(tracks, found.buses, now);
        if (target) {
          // The bus is confirmed: only the door matters now (no more sign reading).
          draw(overlay, video, tracks, target, guideDoor(video, now));
          requestNext();
          return;
        }
        const near = tracks.filter(function (item) {
          return item.lastSeen === now && item.box.w >= MIN_BUS_WIDTH;
        });
        if (near.length && now - lastSeenSpoken > REPEAT_AFTER_MS * 2) {
          lastSeenSpoken = now;
          sayPhrase("bus_seen");
        }
        near
          .sort(function (a, b) {
            return b.box.w - a.box.w; // closest bus first
          })
          .forEach(function (item) {
            if (!item.pending && pending < MAX_PENDING && now - item.lastAsked >= ASK_EVERY_MS) {
              ask(video, item, now, found.others);
            }
          });
        draw(overlay, video, tracks, null, null);
        requestNext();
      }

      function requestNext(): void {
        frames++;
        const now = performance.now();
        if (now - fpsStart >= 1000) {
          setFps(Math.round((frames * 1000) / (now - fpsStart)));
          frames = 0;
          fpsStart = now;
        }
        // Browsers pause animation frames in hidden tabs; keep going (slowly) for desktop testing.
        if (document.hidden) {
          setTimeout(tick, 100);
        } else {
          requestAnimationFrame(tick);
        }
      }

      async function start(): Promise<void> {
        // ?video=/test/bus.webm plays a recorded clip instead of the camera (testing, demo video);
        // ?image=/test/tov_nomyn_san_1.png shows a still photo as if the camera were pointed at it.
        const params = new URLSearchParams(window.location.search);
        const recorded = params.get("video");
        const photo = params.get("image");
        if (photo) {
          stream = await photoStream(photo);
        } else if (!recorded) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false,
            });
          } catch {
            sayPhrase("camera_failed");
            onError();
            return;
          }
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
        } catch {
          return; // unmounted while starting (React runs effects twice in dev)
        }
        if (stopped) {
          return;
        }
        sayPhrase("camera_on");
        setStatus("Загвар ачаалж байна…");
        const provider = await loadDetector();
        setStatus("Автобус хайж байна (" + provider + ")");
        tick();
      }

      start();
      return function () {
        stopped = true;
        stopBeacon();
        guide.current = null;
        if (stream) {
          stream.getTracks().forEach(function (item) {
            item.stop();
          });
        }
      };
    },
    [stopId, route, foundSpeech, onFound, onError, guide],
  );

  return (
    <div className="camera">
      <video ref={videoRef} playsInline muted className="camera-video" />
      <canvas ref={overlayRef} className="camera-overlay" aria-hidden="true" />
      <p className="camera-status">
        {status} · {fps} FPS
      </p>
    </div>
  );
}
