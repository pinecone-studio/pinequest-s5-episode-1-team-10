"use client";

// Walking to the boarding stop: GPS + the phone's compass give the stop's direction from where the
// camera faces. The door beacon is panned toward the stop (faster as the rider faces it) and every
// few seconds: "Зогсоол 2 цагийн зүгт. 120 метр." Within ~8-15 m on two GPS fixes: "you are at the stop".
// Straight-line direction only (not street by street): the rider keeps to the sidewalk, the cane
// handles obstacles. GPS is smoothed and the compass corrected from the walking direction
// (lib/walkFilter.ts); no compass: the GPS walking direction, else distance + closer/farther.
// simulate (?walk=sim): a demo walk from 160 m away at running speed, for the pitch stage.
import { useEffect, useState, type MutableRefObject } from "react";
import { aimBeacon, startBeacon, stopBeacon } from "../lib/beacon";
import { requestCompassPermission, watchCompass } from "../lib/compass";
import { bearing, metres, offset, relative } from "../lib/geo";
import { CompassCorrection, courseHeading, PositionFilter, type Fix } from "../lib/walkFilter";
import { phrase, say, vibrate, type PhraseKey } from "../lib/speech";

interface Props {
  stop: { lat: number; lon: number; name: string };
  start: { lat: number; lon: number } | null; // where the rider is now, if known
  simulate: boolean;
  info: MutableRefObject<string[] | null>; // latest guidance, for "Зогсоол хаана байна?"
  onArrived: () => void;
}

const ARRIVE_M = 8; // + half the GPS uncertainty; simulated ±12 m GPS: "arrived" ~8 m from the stop, worst ~12 m
const COURSE_FRESH_MS = 3000;
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
      const filter = new PositionFilter(stop.lat, stop.lon);
      const correction = new CompassCorrection();
      let compassRaw: number | null = null; // smoothed, before correction
      let compassAt = 0;
      let course: number | null = null; // GPS walking direction
      let courseAt = 0;
      let fixes = 0; // GPS fixes used so far
      let nearFixes = 0; // consecutive fixes within arrival distance
      let lastNearFix = -1;
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

      function onFix(f: Fix): void {
        if (filter.update(f)) {
          fixes++;
        }
        const c = courseHeading(f);
        if (c !== null) {
          course = c;
          courseAt = f.t;
          if (compassRaw !== null && f.t - compassAt < NO_COMPASS_MS) {
            correction.learn(compassRaw, f); // walking straight: the compass's error shows
          }
        }
      }

      function update(): void {
        if (stopped || arrived) {
          return;
        }
        const now = performance.now();
        if (!filter.ready()) {
          if (!gpsWarned && now - startedAt > NO_GPS_MS) {
            gpsWarned = true;
            speak([phrase("walk_no_gps")], resume);
          }
          return;
        }
        const d = filter.distance();
        setDist(d);
        // Arrived: within reach on two separate GPS fixes (one lucky fix isn't enough).
        if (d < ARRIVE_M + 0.5 * Math.min(30, filter.sigma())) {
          if (fixes !== lastNearFix) {
            nearFixes++;
            lastNearFix = fixes;
          }
        } else {
          nearFixes = 0;
        }
        if (nearFixes >= 2) {
          arrived = true;
          stopBeacon();
          vibrate([400, 100, 400]);
          say([phrase("walk_arrived")]);
          onArrived();
          return;
        }
        // Corrected compass; without one, the GPS walking direction while the rider walks.
        const compass = compassRaw !== null && now - compassAt < NO_COMPASS_MS ? correction.apply(compassRaw) : null;
        const heading = compass ?? (course !== null && now - courseAt < COURSE_FRESH_MS ? course : null);
        let parts: string[];
        if (heading !== null) {
          const r = relative(filter.bearingToOrigin(), heading);
          setRel(r);
          aimBeacon(Math.max(-90, Math.min(90, r)));
          parts = [phrase(("walk_clock_" + walkClock(r)) as PhraseKey), walkMetres(d)];
        } else {
          setRel(null);
          stopBeacon();
          if (!compassWarned && compass === null && now - startedAt > NO_COMPASS_MS) {
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
        const at = function (t: number): { lat: number; lon: number } {
          const f = Math.min(total, Math.max(0, t - 4) * SIM_SPEED) / total; // stands still while turning
          return { lat: from.lat + (stop.lat - from.lat) * f, lon: from.lon + (stop.lon - from.lon) * f };
        };
        timers.push(
          setInterval(function () {
            // compass, 4 Hz
            const t = (performance.now() - t0) / 1000;
            const p = at(t);
            compassRaw = bearing(p.lat, p.lon, stop.lat, stop.lon) + 70 * Math.max(0, 1 - t / 4) + 4 * Math.sin(t * 2);
            compassAt = performance.now();
          }, 250),
          setInterval(function () {
            // GPS, 1 Hz, like a phone
            const now = performance.now();
            const t = (now - t0) / 1000;
            const p = at(t);
            const walking = t > 4 && metres(p.lat, p.lon, stop.lat, stop.lon) > 0.5;
            onFix({ lat: p.lat, lon: p.lon, accuracy: 5, heading: walking ? bearing(p.lat, p.lon, stop.lat, stop.lon) : null, speed: walking ? SIM_SPEED : 0, t: now });
          }, 1000),
        );
      } else {
        if (start) {
          // Where the rider was a moment ago, loosely, until the GPS speaks.
          onFix({ lat: start.lat, lon: start.lon, accuracy: 40, heading: null, speed: null, t: performance.now() });
        }
        if ("geolocation" in navigator) {
          watchId = navigator.geolocation.watchPosition(
            function (p) {
              const c = p.coords;
              onFix({ lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, t: performance.now() });
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
            compassRaw = ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
            compassAt = performance.now();
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
