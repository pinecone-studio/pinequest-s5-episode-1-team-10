"use client";

// On the bus: follows the rider's GPS along the route's real stop list (Hamuga) and says each stop as
// it comes up, how many are left, "get ready" one stop before, and "get off now" at theirs.
// simulate: the bus drives the real stops at demo speed (pitch stage, desk testing).
import { useEffect, useState, type MutableRefObject } from "react";
import type { RideResponse, RideStop } from "../../shared/contract";
import { phrase, say, vibrate, type PhraseKey } from "../lib/speech";

export interface RideInfo {
  left: number; // stops still to ride
  next: string; // "Дараагийн зогсоол: ..." or ""
}

interface Props {
  route: string;
  board: string;
  alight: string;
  simulate: boolean;
  info: MutableRefObject<RideInfo | null>;
  onArrived: () => void;
}

const REACH_M = 60; // within this of a stop = the bus is at it
const ANNOUNCE_M = 300; // say the next stop when this close
const OFF_M = 150; // "get off now" when the bus is this close to the rider's stop
const LOST_MS = 60000; // no GPS fix this long -> tell the rider to ask the driver
const SIM_SEGMENT_MS = 3500; // simulated drive between two stops
const SIM_DWELL_MS = 1500; // simulated stop at each stop

function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}

export function leftSpeech(left: number): string {
  return left >= 1 && left <= 20 ? phrase(("left_" + left) as PhraseKey) : "";
}

export default function RideGuide({ route, board, alight, simulate, info, onArrived }: Props) {
  const [stops, setStops] = useState<RideStop[]>([]);
  const [reached, setReached] = useState(0);
  const [error, setError] = useState("");

  useEffect(
    function () {
      let stopped = false;
      let watchId: number | null = null;
      let simTimer: ReturnType<typeof setTimeout> | null = null;
      let lostTimer: ReturnType<typeof setTimeout> | null = null;
      let list: RideStop[] = [];
      let at = 0; // last stop the bus has reached
      let announced = 0; // last stop whose "next stop" was said
      let preparedSaid = false;
      let offSaid = false;
      let arrived = false;

      // The next stop that can be announced: Hamuga has no name/coordinates for a few (they still count).
      function nextNamed(): number {
        for (let j = at + 1; j < list.length; j++) {
          if (list[j].speech && list[j].lat !== null && list[j].lon !== null) {
            return j;
          }
        }
        return list.length - 1;
      }

      function update(): void {
        const last = list.length - 1;
        info.current = { left: last - at, next: at < last ? list[nextNamed()].speech : "" };
        setReached(at);
      }

      function onPosition(lat: number, lon: number): void {
        if (stopped || !list.length) {
          return;
        }
        if (lostTimer) {
          clearTimeout(lostTimer);
        }
        lostTimer = setTimeout(function () {
          say([phrase("ride_lost")]);
        }, LOST_MS);
        const last = list.length - 1;
        // Reached: the farthest stop ahead within REACH_M (stops without coordinates are passed implicitly).
        for (let j = at + 1; j <= last; j++) {
          const s = list[j];
          if (s.lat !== null && s.lon !== null && metres(lat, lon, s.lat, s.lon) < REACH_M) {
            at = j;
          }
        }
        const next = nextNamed();
        const target = list[last];
        if (next === last || at === last) {
          const prev = list[last - 1];
          const leftPrev = prev.lat === null || prev.lon === null || metres(lat, lon, prev.lat, prev.lon) > REACH_M;
          if (!preparedSaid && at === last - 1 && leftPrev) {
            preparedSaid = true;
            vibrate([150, 100, 150]);
            say([phrase("prepare_off")]);
          }
          if (!offSaid && target.lat !== null && target.lon !== null && metres(lat, lon, target.lat, target.lon) < OFF_M) {
            offSaid = true;
            vibrate([600, 150, 600, 150, 600]);
            say([phrase("get_off_now")]);
          }
          if (at === last && offSaid && !arrived) {
            arrived = true;
            setTimeout(function () {
              if (!stopped) {
                onArrived();
              }
            }, SIM_DWELL_MS * 2);
          }
        } else if (next > announced) {
          const s = list[next];
          if (metres(lat, lon, s.lat as number, s.lon as number) < ANNOUNCE_M) {
            announced = next;
            say([s.speech, leftSpeech(last - next)].filter(Boolean));
          }
        }
        update();
      }

      // The bus driving the real stops: segment by segment, a short stop at each.
      function simulateDrive(): void {
        const points = list.filter(function (item) {
          return item.lat !== null && item.lon !== null;
        });
        let i = 0;
        function drive(): void {
          if (stopped || i >= points.length - 1) {
            return;
          }
          const a = points[i];
          const b = points[i + 1];
          const t0 = performance.now();
          function stepOnce(): void {
            if (stopped) {
              return;
            }
            const f = Math.min(1, (performance.now() - t0) / SIM_SEGMENT_MS);
            onPosition((a.lat as number) + ((b.lat as number) - (a.lat as number)) * f, (a.lon as number) + ((b.lon as number) - (a.lon as number)) * f);
            if (f < 1) {
              simTimer = setTimeout(stepOnce, 250);
            } else {
              i++;
              simTimer = setTimeout(drive, SIM_DWELL_MS);
            }
          }
          stepOnce();
        }
        simTimer = setTimeout(drive, 4000); // after "have a good trip"
      }

      async function start(): Promise<void> {
        let res: Response;
        try {
          res = await fetch(
            "/api/ride?route=" + encodeURIComponent(route) + "&board=" + encodeURIComponent(board) + "&alight=" + encodeURIComponent(alight),
          );
        } catch {
          setError(phrase("server_down"));
          say([phrase("server_down")]);
          return;
        }
        if (!res.ok || stopped) {
          setError(phrase("ride_lost"));
          return;
        }
        list = ((await res.json()) as RideResponse).stops;
        update();
        setStops(list);
        say([phrase("ride_start")]);
        if (simulate) {
          simulateDrive();
        } else if ("geolocation" in navigator) {
          watchId = navigator.geolocation.watchPosition(
            function (pos) {
              onPosition(pos.coords.latitude, pos.coords.longitude);
            },
            function () {},
            { enableHighAccuracy: true, maximumAge: 2000 },
          );
        }
      }

      start();
      return function () {
        stopped = true;
        if (watchId !== null) {
          navigator.geolocation.clearWatch(watchId);
        }
        if (simTimer) {
          clearTimeout(simTimer);
        }
        if (lostTimer) {
          clearTimeout(lostTimer);
        }
      };
    },
    [route, board, alight, simulate, info, onArrived],
  );

  const last = stops.length - 1;
  return (
    <div className="ride">
      {error && <p className="ride-error">{error}</p>}
      {stops.length > 0 && (
        <>
          <p className="ride-left">
            {reached >= last ? "Буух зогсоол" : "Буух хүртэл " + (last - reached) + " зогсоол"}
          </p>
          <ol className="ride-stops">
            {stops.map(function (item, i) {
              const state = i < reached ? "passed" : i === reached ? "here" : i === last ? "off" : "";
              return (
                <li key={item.stop_id + i} className={state}>
                  {item.name || "(нэргүй зогсоол)"}
                  {i === last ? " · буух" : ""}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
