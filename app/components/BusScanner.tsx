"use client";

// Camera step with the cloud sign reader (opt-in: ?scanner=azure). No models on the phone: lit LED signs
// are found by colour (lib/crop-led.ts), each crop is read by Azure (/api/read-sign), and the FIRST frame
// whose sign is the rider's route says "yes", if the bus data agrees: the route stops here and no other
// route here could show that sign (lib/parse-sign.ts). Never more than 3 reads in flight and never over
// Azure's free tier (lib/call-budget.ts): frames beyond that are dropped, so the camera loop never waits.
// No door guidance or "bus moving" warning here: those are BusCamera's (the default camera step).
import { useEffect, useRef } from "react";
import type { ReadSignResponse } from "../../shared/contract";
import { createAnnouncer } from "../lib/announcer";
import { iou, type Box } from "../lib/box";
import { createCallBudget } from "../lib/call-budget";
import { createLedCropper, type LedCrop } from "../lib/crop-led";
import { makeRouteBook, matchSign, type RouteBook } from "../lib/parse-sign";
import { explainPermission } from "../lib/permissions";
import { phrase, prepareInstant, type Earcon } from "../lib/speech";
import { candidatesNear, loadRouteData, routeKey } from "../lib/candidates";
import { matchSign as matchCandidates } from "../lib/signMatch";
import { loadLocalOcr, localOcrState, readLocal } from "../lib/localSignOcr";
import { cityNumbers, prefetchStopRoutes, routesFor } from "../lib/stopRoutes";
import { latencyText, markDecided } from "../lib/latency";

interface Props {
  stopId: string;
  route: string;
  foundSpeech: string;
  onFound: () => void;
  onError: () => void;
  onAnnounce: (texts: string[], earcon?: Earcon) => Promise<void>; // status text and speech
}

const FRAME_MS = 100; // ~10 frames a second
const MAX_IN_FLIGHT = 3;
const MAX_REQUESTS_PER_SEC = 20 / 60; // Azure free tier (F0): 20 a minute, shared by every phone using the key
const CALLS_PER_MINUTE = MAX_REQUESTS_PER_SEC * 60;
const WARM_EVERY_MS = 60000; // keep the server function and its Azure connection warm while the camera is open
const CROP_BYTES = 20 * 1024; // target for a sign crop (grayscale JPEG, 10-20 KB)
const TIMING_SAMPLES = 50; // for p50 / p95 on the debug line
const BURST = 5; // reads sent at once when a sign appears; then one every 4 s
const READ_TIMEOUT_MS = 2500; // a later answer is no vote
const NO_ANSWER_MS = 5000; // reads sent this long with no answer at all -> "not sure"
const FAILURES_GIVE_UP = 5; // server errors in a row -> "the reader doesn't work"
const NOISE_MS = 4000; // an LED box that read no route number (a shop sign) is skipped this long
const NOISE_IOU = 0.6;
const NO_SIGN_HINT_MS = 12000; // no lit sign this long: "no bus, keep pointing at the road"
const SIGN_HARD_MS = 10000; // signs read unclearly ("?") this long with no route number: "point at the front"
const UNCLEAR_RECENT_MS = 3000;
// JPEG qualities tried, highest first, until a crop is under CROP_BYTES. A whole frame (960 px) is sent at
// 0.5: ~80 KB, the smallest that still read the sign on photo 1 (640 px / 39 KB read nothing).
const CROP_QUALITIES = [0.75, 0.6, 0.45];
const FRAME_QUALITY = 0.6;

function percentile(values: number[], p: number): number {
  if (!values.length) {
    return 0;
  }
  const sorted = values.slice().sort(function (a, b) {
    return a - b;
  });
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(function (resolve) {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
}

// The crop in grayscale on its own canvas (the cropper reuses its canvas on the next frame), as JPEG:
// colour adds bytes and nothing for reading a sign.
async function grayCrop(crop: LedCrop): Promise<{ blob: Blob | null; gray: HTMLCanvasElement }> {
  const from = crop.canvas;
  const c = document.createElement("canvas");
  c.width = from.width;
  c.height = from.height;
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(from, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    d[i] = y;
    d[i + 1] = y;
    d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  if (crop.kind === "frame") {
    return { blob: await jpeg(c, FRAME_QUALITY), gray: c };
  }
  let blob: Blob | null = null;
  for (let i = 0; i < CROP_QUALITIES.length; i++) {
    blob = await jpeg(c, CROP_QUALITIES[i]);
    if (!blob || blob.size <= CROP_BYTES) {
      break;
    }
  }
  return { blob, gray: c };
}

// One read of a crop in the race: on the phone (lib/localSignOcr.ts) or Azure.
interface RaceRead {
  source: "local" | "azure";
  body: ReadSignResponse;
  ms: number; // from sending to the answer
}

// What the scanner is doing (?debug=1 shows it; tests read window.__scan).
interface ScanStats {
  stage: string;
  video: string;
  frames: number;
  sent: number;
  answers: number;
  busy: number; // crops dropped: 3 reads in flight
  overBudget: number; // crops dropped: free-tier budget spent
  noise: number; // crops skipped: the same box read no route number just before
  lastLines: string;
  azureMs: number;
  roundTripMs: number;
  lastKB: number; // size of the last image sent
  timing: string; // p50 / p95 of the phone's whole wait and of the Azure call
  yesMs: number; // camera open -> "yes"
  error: string;
}

export default function BusScanner({ stopId, route, foundSpeech, onFound, onError, onAnnounce }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const debugRef = useRef<HTMLParagraphElement>(null);
  const announceRef = useRef(onAnnounce);
  useEffect(function () {
    announceRef.current = onAnnounce;
  });

  useEffect(
    function () {
      let stopped = false;
      let found = false;
      let gaveUp = false;
      let stream: MediaStream | null = null;
      let timer = 0;
      let inFlight = 0;
      let failures = 0;
      let waitingSince = 0; // first read sent since the last answer; 0: none waiting
      let lookingSince = 0;
      let lastSignAt = 0;
      let lastRouteAt = 0; // last read that named a route number (ours or not)
      let lastUnclearAt = 0; // last read with a word below the confidence threshold
      let lastHint = 0;
      let book: RouteBook | null = null;
      let bookHere: string[] | null = null;
      let bookCity: Set<string> | null = null;
      const openedAt = performance.now();
      const noise: { box: Box; until: number }[] = [];
      const cropper = createLedCropper();
      const budget = createCallBudget(CALLS_PER_MINUTE, BURST);
      const announcer = createAnnouncer(function (texts, earcon) {
        return announceRef.current(texts, earcon);
      });
      const stats: ScanStats = { stage: "starting", video: "", frames: 0, sent: 0, answers: 0, busy: 0, overBudget: 0, noise: 0, lastLines: "", azureMs: 0, roundTripMs: 0, lastKB: 0, timing: "", yesMs: 0, error: "" };
      const totals: number[] = [];
      const azures: number[] = [];
      const localTimes: number[] = []; // on-device read, from sending to the answer
      const raced = { total: 0, local: 0 }; // decisions, and how many the phone's read made
      (window as unknown as { __scan: ScanStats }).__scan = stats;
      const debugTimer = setInterval(function () {
        if (debugRef.current) {
          debugRef.current.textContent =
            stats.stage + " · " + stats.video + " · frames " + stats.frames + " · sent " + stats.sent + " · answers " + stats.answers + " · dropped busy " + stats.busy + " / budget " + stats.overBudget + " / noise " + stats.noise + " · azure " + stats.azureMs + " ms · round trip " + stats.roundTripMs + " ms · last " + stats.lastKB + " KB" + (stats.timing ? " · " + stats.timing : "") + (stats.lastLines ? " «" + stats.lastLines + "»" : "") + (stats.yesMs ? " · yes " + stats.yesMs + " ms" : "") + " · local " + localOcrState() + (localTimes.length ? " p50 " + percentile(localTimes, 50) + " ms" : "") + " · azure p50 " + percentile(totals, 50) + " ms · local wins " + raced.local + "/" + raced.total + (raced.total ? " (" + Math.round((100 * raced.local) / raced.total) + "%)" : "") + (latencyText() ? " · " + latencyText() : "") + (stats.error ? " · ERROR " + stats.error : "");
        }
      }, 500);

      function speak(texts: string[]): void {
        announceRef.current(texts);
      }

      // The stop's routes come from the plan (or the refresh it started); rebuilt only when they change.
      function routeBook(): RouteBook {
        const here = routesFor(stopId);
        const city = cityNumbers();
        if (!book || here !== bookHere || city !== bookCity) {
          book = makeRouteBook(here, city);
          bookHere = here;
          bookCity = city;
        }
        return book;
      }

      function isNoise(box: Box, now: number): boolean {
        for (let i = noise.length - 1; i >= 0; i--) {
          if (noise[i].until <= now) {
            noise.splice(i, 1);
          }
        }
        return noise.some(function (item) {
          return iou(item.box, box) > NOISE_IOU;
        });
      }

      function giveUp(): void {
        if (gaveUp || stopped) {
          return;
        }
        gaveUp = true;
        speak([phrase("ocr_failed")]);
        onError();
      }

      // Fast path: the read clearly picks the rider's route among the routes near this stop
      // (lib/signMatch.ts); else the sign parser's own rules (lib/parse-sign.ts).
      function verdictOf(lines: string[]): { verdict: "yes" | "no" | "unsure"; route: string | null } {
        const wantedKey = routeKey(route);
        const pool = wantedKey ? candidatesNear(stopId) : null;
        const quick = pool ? matchCandidates(lines.join(" "), wantedKey as string, pool.near, pool.all) : null;
        const parsed = matchSign(lines, route, routeBook());
        return quick && quick.verdict === "yes" ? { verdict: "yes", route: parsed.route ?? (wantedKey as string) } : parsed;
      }

      // A read that settles it (yes, or clearly another route): used at once, the other read stopped.
      function conclusive(lines: string[]): boolean {
        const m = verdictOf(lines);
        return m.verdict !== "unsure" && m.route !== null;
      }

      function decide(body: ReadSignResponse, crop: LedCrop, sentAt: number): void {
        const now = performance.now();
        stats.answers++;
        stats.lastLines = body.lines.join(" | ");
        stats.azureMs = body.azureMs;
        stats.roundTripMs = Math.round(now - sentAt);
        const match = verdictOf(body.lines);
        if (match.route) {
          lastRouteAt = now;
          cropper.routeRead(now);
        }
        if (match.verdict === "yes" && match.route) {
          found = true;
          stats.stage = "found";
          stats.yesMs = Math.round(now - openedAt);
          console.info("[scan] yes after " + stats.yesMs + " ms from camera open, read took " + stats.roundTripMs + " ms (azure " + body.azureMs + " ms)");
          markDecided("azure scanner", now, sentAt); // the frame was cut and sent at sentAt
          announcer.announce(match.route, [foundSpeech], now, "match");
          onFound();
          return;
        }
        if (match.verdict === "no" && match.route) {
          announcer.announce(match.route, [phrase("not_your_bus")], now, "wrong");
          return;
        }
        if (match.route) {
          announcer.announce("unsure", [phrase("not_sure")], now);
          return;
        }
        // Read clearly and no route in it (a shop sign, the destination half of the sign): skip that box for a
        // while. A doubtful ("?") or empty read (LED flicker) is tried again.
        const unclear = body.lines.some(function (item) {
          return item.indexOf("?") >= 0;
        });
        if (unclear) {
          lastUnclearAt = now;
        } else if (crop.kind === "led" && body.lines.length) {
          noise.push({ box: crop.box, until: now + NOISE_MS });
        }
      }

      async function azureBody(res: Response): Promise<ReadSignResponse | null> {
        if (stopped || found) {
          return null;
        }
        if (res.status === 429) {
          const wait = parseFloat(res.headers.get("retry-after") ?? "");
          budget.pauseUntil(performance.now() + (Number.isFinite(wait) ? wait : 10) * 1000);
          stats.error = "Azure rate limit";
          return null;
        }
        if (res.status === 503) {
          stats.error = "no Azure key on the server";
          giveUp();
          return null;
        }
        if (!res.ok) {
          stats.error = "read " + res.status;
          failures++;
          if (failures >= FAILURES_GIVE_UP) {
            giveUp();
          }
          return null;
        }
        const body = (await res.json()) as ReadSignResponse;
        failures = 0;
        return body;
      }

      // The race for one crop: whichever read arrives first and settles it is used, the other stopped;
      // if the first doesn't settle it, the other is waited for (Azure's read preferred when both are in).
      function race(azure: Promise<RaceRead | null>, local: Promise<RaceRead | null>, stopAzure: AbortController, stopLocal: AbortController, crop: LedCrop, sentAt: number): Promise<void> {
        return new Promise<void>(function (resolve) {
          let left = 2;
          let used = false;
          const pending: RaceRead[] = [];
          function take(r: RaceRead, first: boolean): void {
            used = true;
            waitingSince = 0;
            raced.total++;
            if (r.source === "local") {
              raced.local++;
            }
            console.info("[race] " + r.source + " " + (first ? "won" : "used") + " in " + r.ms + " ms: " + r.body.lines.join(" | ").slice(0, 60));
            if (!stopped && !found) {
              decide(r.body, crop, sentAt);
            }
          }
          function settle(r: RaceRead | null): void {
            left--;
            if (!used && r) {
              if (conclusive(r.body.lines)) {
                take(r, true);
                (r.source === "local" ? stopAzure : stopLocal).abort();
              } else {
                pending.push(r);
              }
            }
            if (left === 0) {
              if (!used && pending.length) {
                take(
                  pending.find(function (item) {
                    return item.source === "azure";
                  }) ?? pending[0],
                  false,
                );
              }
              resolve();
            }
          }
          azure.then(settle);
          local.then(settle);
        });
      }

      // JPEG of the crop, then one read. The crop's canvas is copied by toBlob at once, so the next
      // frame may reuse it.
      function send(crop: LedCrop, now: number): void {
        inFlight++;
        stats.sent++;
        if (!waitingSince) {
          waitingSince = now;
        }
        grayCrop(crop).then(function (prep) {
          const blob = prep.blob;
          if (!blob || stopped) {
            inFlight--;
            return;
          }
          stats.lastKB = Math.round(blob.size / 102.4) / 10;
          const stopAzure = new AbortController();
          const stopLocal = new AbortController();
          const timeout = setTimeout(function () {
            stopAzure.abort();
            stopLocal.abort();
          }, READ_TIMEOUT_MS);
          const sentAt = performance.now();
          const azure = fetch("/api/read-sign", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob, signal: stopAzure.signal })
            .then(function (res) {
              timed(res, blob.size, sentAt, crop.kind);
              return azureBody(res);
            })
            .then(function (body): RaceRead | null {
              return body ? { source: "azure", body, ms: Math.round(performance.now() - sentAt) } : null;
            })
            .catch(function (e) {
              if (!stopAzure.signal.aborted) {
                stats.error = "read " + (e instanceof Error ? e.name : String(e)); // late or offline: no vote
              }
              return null;
            });
          // On the phone too (LED crops only: a whole frame needs a text detector), started together.
          const local =
            crop.kind === "led"
              ? readLocal(prep.gray, stopLocal.signal).then(function (r): RaceRead | null {
                  if (!r) {
                    return null;
                  }
                  const ms = Math.round(performance.now() - sentAt);
                  localTimes.push(ms);
                  if (localTimes.length > TIMING_SAMPLES) {
                    localTimes.shift();
                  }
                  return { source: "local", body: { lines: r.text ? [r.text] : [], azureMs: 0, serverMs: 0 }, ms };
                })
              : Promise.resolve(null);
          race(azure, local, stopAzure, stopLocal, crop, sentAt).finally(function () {
            clearTimeout(timeout);
            inFlight--;
          });
        });
      }

      // Per request: bytes, upload + network (the phone's wait minus the server's time), Azure, total.
      function timed(res: Response, bytes: number, sentAt: number, kind: string): void {
        const total = Math.round(performance.now() - sentAt);
        res
          .clone()
          .json()
          .then(function (body: ReadSignResponse) {
            if (typeof body.azureMs !== "number") {
              return;
            }
            totals.push(total);
            azures.push(body.azureMs);
            if (totals.length > TIMING_SAMPLES) {
              totals.shift();
              azures.shift();
            }
            stats.timing = "total p50 " + percentile(totals, 50) + " / p95 " + percentile(totals, 95) + " ms · azure p50 " + percentile(azures, 50) + " / p95 " + percentile(azures, 95) + " ms";
            console.info("[read] " + kind + " " + Math.round(bytes / 1024) + " KB · upload+network " + Math.max(0, total - body.serverMs) + " ms · azure " + body.azureMs + " ms · total " + total + " ms");
          })
          .catch(function () {});
      }

      // Warm-up while the camera is open: one tiny read now and every 60 s (server function + its Azure
      // connection stay warm). Uses the same budget as the real reads; skipped when it's spent.
      let warmImage: Promise<Blob | null> | null = null;
      function warmUp(): void {
        if (stopped || found || !budget.take(performance.now())) {
          return;
        }
        if (!warmImage) {
          warmImage = fetch("/warm.jpg")
            .then(function (res) {
              return res.ok ? res.blob() : null;
            })
            .catch(function () {
              return null;
            });
        }
        warmImage.then(function (blob) {
          if (!blob || stopped) {
            return;
          }
          const sentAt = performance.now();
          fetch("/api/read-sign?warm=1", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob })
            .then(function (res) {
              if (res.status === 429) {
                const wait = parseFloat(res.headers.get("retry-after") ?? "");
                budget.pauseUntil(performance.now() + (Number.isFinite(wait) ? wait : 10) * 1000);
                return;
              }
              timed(res, blob.size, sentAt, "warm");
            })
            .catch(function () {});
        });
      }
      warmUp();
      const warmTimer = window.setInterval(warmUp, WARM_EVERY_MS);

      function tick(): void {
        if (stopped || found || gaveUp) {
          return;
        }
        const video = videoRef.current;
        const now = performance.now();
        if (video && video.readyState >= 2 && video.videoWidth) {
          stats.frames++;
          stats.video = video.videoWidth + "x" + video.videoHeight;
          const crops = cropper.next(video, now);
          if (
            crops.some(function (item) {
              return item.kind === "led";
            })
          ) {
            lastSignAt = now;
          }
          crops.forEach(function (item) {
            if (item.kind === "led" && isNoise(item.box, now)) {
              stats.noise++;
            } else if (inFlight >= MAX_IN_FLIGHT) {
              stats.busy++;
            } else if (!budget.take(now)) {
              stats.overBudget++;
            } else {
              send(item, now);
              if (item.kind === "frame") {
                cropper.frameSent(now);
              }
            }
          });
          if (waitingSince && now - waitingSince > NO_ANSWER_MS) {
            waitingSince = now;
            announcer.announce("unsure", [phrase("not_sure")], now);
          }
          if (now - Math.max(lastSignAt, lookingSince) > NO_SIGN_HINT_MS && now - lastHint > NO_SIGN_HINT_MS) {
            lastHint = now;
            speak([phrase("no_bus_yet")]);
          } else if (now - lastUnclearAt < UNCLEAR_RECENT_MS && now - Math.max(lastRouteAt, lookingSince) > SIGN_HARD_MS && now - lastHint > SIGN_HARD_MS) {
            lastHint = now;
            speak([phrase("sign_hard")]);
          }
        }
        timer = window.setTimeout(tick, FRAME_MS);
      }

      function openCamera(): Promise<MediaStream> {
        return navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      }

      // iPhone stops the camera while the page is hidden (locked screen, a call): start it again.
      async function onVisibility(): Promise<void> {
        const video = videoRef.current;
        if (document.visibilityState !== "visible" || !stream || !video || stopped) {
          return;
        }
        const live = stream.getVideoTracks().some(function (item) {
          return item.readyState === "live";
        });
        if (live) {
          return;
        }
        try {
          stream = await openCamera();
          video.srcObject = stream;
          await video.play();
          speak([phrase("camera_on")]);
        } catch (e) {
          stats.error = "camera again " + (e instanceof Error ? e.name : "");
        }
      }

      // ?video=/test/bus.webm plays a recorded clip instead of the camera (testing).
      const recorded = new URLSearchParams(window.location.search).get("video");

      async function start(): Promise<void> {
        if (!routesFor(stopId)) {
          prefetchStopRoutes(stopId, [], ""); // the plan step already asked; in case it failed
        }
        loadRouteData(); // routes near this stop, for the fast match
        loadLocalOcr(); // the on-device sign reader (lib/localSignOcr.ts), racing Azure on each LED crop
        announcer.preload([foundSpeech, phrase("not_your_bus"), phrase("not_sure")]);
        prepareInstant([foundSpeech, phrase("not_your_bus")]); // decoded into memory: no wait at the verdict
        const video = videoRef.current;
        if (!video) {
          return;
        }
        if (recorded) {
          video.src = recorded;
          video.loop = true;
        } else {
          await explainPermission("camera");
          try {
            const opened = await openCamera();
            if (stopped) {
              opened.getTracks().forEach(function (item) {
                item.stop();
              });
              return;
            }
            stream = opened;
          } catch (e) {
            stats.error = "camera " + (e instanceof Error ? e.name : "");
            if (!stopped) {
              speak([phrase("camera_failed")]);
              onError();
            }
            return;
          }
          video.srcObject = stream;
        }
        try {
          await video.play();
        } catch {
          if (stopped) {
            return;
          }
          // iPhone can refuse to start the video outside a touch: start it on the rider's next one.
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
        stats.stage = "looking";
        lookingSince = performance.now();
        speak([phrase("camera_on")]);
        tick();
      }

      document.addEventListener("visibilitychange", onVisibility);
      start();
      return function () {
        stopped = true;
        clearTimeout(timer);
        clearInterval(debugTimer);
        clearInterval(warmTimer);
        document.removeEventListener("visibilitychange", onVisibility);
        if (stream) {
          stream.getTracks().forEach(function (item) {
            item.stop();
          });
        }
      };
    },
    [stopId, route, foundSpeech, onFound, onError],
  );

  return (
    <div className="camera">
      <video ref={videoRef} playsInline muted className="camera-video" aria-hidden="true" />
      {typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug") && <p ref={debugRef} className="camera-debug" />}
    </div>
  );
}
