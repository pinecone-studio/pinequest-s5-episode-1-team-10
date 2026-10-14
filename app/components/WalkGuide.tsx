"use client";

// Walking to the boarding stop: GPS + the phone's compass give the stop's direction from where the
// camera faces. The door beacon is panned toward the stop (faster as the rider faces it) and every
// few seconds: "Зогсоол 2 цагийн зүгт. 120 метр." Within ~20 m: "you're at the stop" -> camera.
// Straight-line direction only (not street by street): the rider keeps to the sidewalk, the cane
// handles obstacles. No compass (laptop, refused): distance + "getting closer / farther" only.
// simulate (?walk=sim): a demo walk from 160 m away at running speed, for the pitch stage.
import { useEffect, useState, type MutableRefObject } from "react";
import { aimBeacon, startBeacon, stopBeacon } from "../lib/beacon";
import { requestCompassPermission, watchCompass } from "../lib/compass";
import { bearing, metres, offset, relative } from "../lib/geo";
import { phrase, say, vibrate, type PhraseKey } from "../lib/speech";

interface Props {
  stop: { lat: number; lon: number; name: string };
  start: { lat: number; lon: number } | null; // where the rider is now, if known
  simulate: boolean;
  info: MutableRefObject<string[] | null>; // latest guidance, for "Зогсоол хаана байна?"
  onArrived: () => void;
}

const ARRIVE_M = 20;
const SPEAK_EVERY_MS = 7000;
const NO_COMPASS_MS = 3000; // no compass reading this long after start -> distance-only guidance
const NO_GPS_MS = 20000;
const SIM_FROM_M = 160;
const SIM_SPEED = 6; // m/s, demo speed

export function walkClock(rel: number): number {
  const h = Math.round(rel / 30);
  return h <= 0 ? 12 + h : h;
}

// "120 метр." from the pre-made clips: 10 m steps to 100 m, then 50 m steps to 800 m.
export function walkMetres(d: number): string {
  const m = d <= 100 ? Math.max(10, Math.round(d / 10) * 10) : Math.min(800, Math.round(d / 50) * 50);
  return phrase(("walk_m_" + m) as PhraseKey);
}

export default function WalkGuide({ stop, start, simulate, info, onArrived }: Props) {
  const [dist, setDist] = useState<number | null>(null);
  const [rel, setRel] = useState<number | null>(null); // stop direction from where the camera faces

  useEffect(
    function () {
      let stopped = false;
      let pos: { lat: number; lon: number } | null = null;
      let heading: number | null = null;
      let headingAt = 0;
      let lastSpoken = 0;
      let spokenDist: number | null = null;
      let talking = false;
      let speechId = 0; // only the latest line may clear "talking" (an interrupted one resolves early)
      let arrived = false;
      let gpsWarned = false;
      let compassWarned = false;
      const startedAt = performance.now();
      const timers: ReturnType<typeof setInterval>[] = [];
      let watchId: number | null = null;

      function speak(texts: string[], done?: () => void): void {
        const mine = ++speechId;
        talking = true;
        say(texts).then(function () {
          if (mine === speechId) {
            talking = false;
            if (done) {
              done();
            }
          }
        });
      }

      function update(): void {
        if (stopped || arrived) {
          return;
        }
        const now = performance.now();
        if (!pos) {
          if (!gpsWarned && now - startedAt > NO_GPS_MS) {
            gpsWarned = true;
            speak([phrase("walk_no_gps")], resume);
          }
          return;
        }
        const d = metres(pos.lat, pos.lon, stop.lat, stop.lon);
        setDist(d);
        if (d < ARRIVE_M) {
          arrived = true;
          stopBeacon();
          vibrate([400, 100, 400]);
          say([phrase("walk_arrived")]);
          onArrived();
          return;
        }
        const compass = heading !== null && now - headingAt < NO_COMPASS_MS;
        let parts: string[];
        if (compass) {
          const r = relative(bearing(pos.lat, pos.lon, stop.lat, stop.lon), heading as number);
          setRel(r);
          aimBeacon(Math.max(-90, Math.min(90, r)));
          parts = [phrase(("walk_clock_" + walkClock(r)) as PhraseKey), walkMetres(d)];
        } else {
          setRel(null);
          stopBeacon();
          if (!compassWarned && now - startedAt > NO_COMPASS_MS) {
            compassWarned = true;
            speak([phrase("walk_no_compass")], resume);
            return;
          }
          parts = [walkMetres(d)];
          if (spokenDist !== null && Math.abs(spokenDist - d) >= 5) {
            parts.push(phrase(d < spokenDist ? "walk_closer" : "walk_farther"));
          }
        }
        info.current = parts;
        if (!talking && now - lastSpoken > SPEAK_EVERY_MS) {
          lastSpoken = now;
          spokenDist = d;
          speak(parts);
        }
      }

      // Intro first, then guidance at once; the beacon is aimed once a compass heading arrives.
      // Guidance starts once a spoken message (the intro, or a warning that cut in) has finished.
      function resume(): void {
        lastSpoken = 0;
      }
      lastSpoken = performance.now() + 60000; // no guidance over the intro
      speak([phrase("walk_start")], resume);
      startBeacon();
      aimBeacon(90); // slow blips until the stop's direction is known

      if (simulate) {
        // Start SIM_FROM_M south-west of the stop (or where the rider is, if that's farther),
        // walk straight to it; the "rider" first faces 70 deg off and turns toward the stop.
        const from = start && metres(start.lat, start.lon, stop.lat, stop.lon) > 40 ? start : offset(stop.lat, stop.lon, 225, SIM_FROM_M);
        const total = metres(from.lat, from.lon, stop.lat, stop.lon);
        const t0 = performance.now();
        timers.push(
          setInterval(function () {
            const t = (performance.now() - t0) / 1000;
            const walked = Math.min(total, Math.max(0, t - 4) * SIM_SPEED); // stands still while turning
            const f = walked / total;
            pos = { lat: from.lat + (stop.lat - from.lat) * f, lon: from.lon + (stop.lon - from.lon) * f };
            const toStop = bearing(pos.lat, pos.lon, stop.lat, stop.lon);
            heading = toStop + 70 * Math.max(0, 1 - t / 4) + 4 * Math.sin(t * 2);
            headingAt = performance.now();
          }, 250),
        );
      } else {
        pos = start;
        if ("geolocation" in navigator) {
          watchId = navigator.geolocation.watchPosition(
            function (p) {
              pos = { lat: p.coords.latitude, lon: p.coords.longitude };
            },
            function () {},
            { enableHighAccuracy: true, maximumAge: 2000 },
          );
        }
        requestCompassPermission(); // already granted in the tap that opened this screen (iPhone)
      }
      // Smoothed compass (circular average), so the beacon doesn't jitter.
      let sx = 0;
      let sy = 0;
      const unwatch = simulate
        ? function () {}
        : watchCompass(function (h) {
            const r = (h * Math.PI) / 180;
            sx = 0.8 * sx + 0.2 * Math.sin(r);
            sy = 0.8 * sy + 0.2 * Math.cos(r);
            heading = ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
            headingAt = performance.now();
          });
      timers.push(setInterval(update, 500));

      return function () {
        stopped = true;
        stopBeacon();
        unwatch();
        timers.forEach(function (item) {
          clearInterval(item);
        });
        if (watchId !== null) {
          navigator.geolocation.clearWatch(watchId);
        }
      };
    },
    [stop, start, simulate, info, onArrived],
  );

  return (
    <div className="walk">
      <p className="walk-stop">{stop.name}</p>
      <p className="walk-dist">{dist === null ? "…" : Math.round(dist) + " м"}</p>
      {rel !== null && (
        <p className="walk-dir" aria-hidden="true">
          <span className="walk-arrow" style={{ transform: "rotate(" + Math.round(rel) + "deg)" }}>
            ↑
          </span>
          {walkClock(rel)} цаг
        </p>
      )}
    </div>
  );
}
