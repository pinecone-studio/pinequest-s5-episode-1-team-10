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
import { phrase } from "../lib/speech";
import { cityNumbers, prefetchStopRoutes, routesFor } from "../lib/stopRoutes";

interface Props {
  stopId: string;
  route: string;
  foundSpeech: string;
  onFound: () => void;
  onError: () => void;
  onAnnounce: (texts: string[]) => Promise<void>; // status text and speech
}

const FRAME_MS = 100; // ~10 frames a second
const MAX_IN_FLIGHT = 3;
const CALLS_PER_MINUTE = 20; // Azure free tier (F0), shared by every phone using the key
const BURST = 5; // reads sent at once when a sign appears; then one every 4 s
const READ_TIMEOUT_MS = 2500; // a later answer is no vote
const NO_ANSWER_MS = 5000; // reads sent this long with no answer at all -> "not sure"
const FAILURES_GIVE_UP = 5; // server errors in a row -> "the reader doesn't work"
const NOISE_MS = 4000; // an LED box that read no route number (a shop sign) is skipped this long
const NOISE_IOU = 0.6;
const NO_SIGN_HINT_MS = 12000; // no lit sign this long: "no bus, keep pointing at the road"
const SIGN_HARD_MS = 10000; // signs read unclearly ("?") this long with no route number: "point at the front"
const UNCLEAR_RECENT_MS = 3000;
const JPEG_QUALITY = 0.85;

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
      const announcer = createAnnouncer(function (texts) {
        return announceRef.current(texts);
      });
      const stats: ScanStats = { stage: "starting", video: "", frames: 0, sent: 0, answers: 0, busy: 0, overBudget: 0, noise: 0, lastLines: "", azureMs: 0, roundTripMs: 0, yesMs: 0, error: "" };
      (window as unknown as { __scan: ScanStats }).__scan = stats;
      const debugTimer = setInterval(function () {
        if (debugRef.current) {
          debugRef.current.textContent =
            stats.stage + " · " + stats.video + " · frames " + stats.frames + " · sent " + stats.sent + " · answers " + stats.answers + " · dropped busy " + stats.busy + " / budget " + stats.overBudget + " / noise " + stats.noise + " · azure " + stats.azureMs + " ms · round trip " + stats.roundTripMs + " ms" + (stats.lastLines ? " «" + stats.lastLines + "»" : "") + (stats.yesMs ? " · yes " + stats.yesMs + " ms" : "") + (stats.error ? " · ERROR " + stats.error : "");
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

      function decide(body: ReadSignResponse, crop: LedCrop, sentAt: number): void {
        const now = performance.now();
        stats.answers++;
        stats.lastLines = body.lines.join(" | ");
        stats.azureMs = body.timingMs;
        stats.roundTripMs = Math.round(now - sentAt);
        const match = matchSign(body.lines, route, routeBook());
        if (match.route) {
          lastRouteAt = now;
        }
        if (match.verdict === "yes" && match.route) {
          found = true;
          stats.stage = "found";
          stats.yesMs = Math.round(now - openedAt);
          console.info("[scan] yes after " + stats.yesMs + " ms from camera open, read took " + stats.roundTripMs + " ms (azure " + body.timingMs + " ms)");
          announcer.announce(match.route, [foundSpeech], now);
          onFound();
          return;
        }
        if (match.verdict === "no" && match.route) {
          announcer.announce(match.route, [phrase("not_your_bus")], now);
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

      async function answer(res: Response, crop: LedCrop, sentAt: number): Promise<void> {
        if (stopped || found) {
          return;
        }
        if (res.status === 429) {
          const wait = parseFloat(res.headers.get("retry-after") ?? "");
          budget.pauseUntil(performance.now() + (Number.isFinite(wait) ? wait : 10) * 1000);
          stats.error = "Azure rate limit";
          return;
        }
        if (res.status === 503) {
          stats.error = "no Azure key on the server";
          giveUp();
          return;
        }
        if (!res.ok) {
          stats.error = "read " + res.status;
          failures++;
          if (failures >= FAILURES_GIVE_UP) {
            giveUp();
          }
          return;
        }
        const body = (await res.json()) as ReadSignResponse;
        failures = 0;
        waitingSince = 0;
        if (!stopped && !found) {
          decide(body, crop, sentAt);
        }
      }

      // JPEG of the crop, then one read. The crop's canvas is copied by toBlob at once, so the next
      // frame may reuse it.
      function send(crop: LedCrop, now: number): void {
        inFlight++;
        stats.sent++;
        if (!waitingSince) {
          waitingSince = now;
        }
        crop.canvas.toBlob(
          function (blob) {
            if (!blob || stopped) {
              inFlight--;
              return;
            }
            const controller = new AbortController();
            const timeout = setTimeout(function () {
              controller.abort();
            }, READ_TIMEOUT_MS);
            fetch("/api/read-sign", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob, signal: controller.signal })
              .then(function (res) {
                return answer(res, crop, now);
              })
              .catch(function (e) {
                stats.error = "read " + (e instanceof Error ? e.name : String(e)); // late or offline: no vote
              })
              .finally(function () {
                clearTimeout(timeout);
                inFlight--;
              });
          },
          "image/jpeg",
          JPEG_QUALITY,
        );
      }

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
        announcer.preload([foundSpeech, phrase("not_your_bus"), phrase("not_sure")]);
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
