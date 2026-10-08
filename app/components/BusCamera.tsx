"use client";

// Camera step: YOLO finds buses on the phone, each bus is tracked, its sign crop goes to
// /verify (PaddleOCR + Hamuga on the server), and 5 of the last 7 answers must agree.
import { useEffect, useRef, useState } from "react";
import type { Verdict } from "../../shared/contract";
import { verifySign } from "../lib/api";
import { MIN_BUS_WIDTH, signCrop } from "../lib/crop";
import { detectBuses, loadDetector } from "../lib/detector";
import { say, sayPhrase, vibrate } from "../lib/speech";
import { addVote, updateTracks, VOTE_WINDOW, type Track } from "../lib/tracker";

interface Props {
  stopId: string;
  route: string;
  foundSpeech: string;
  onFound: () => void;
  onError: () => void;
}

const ASK_EVERY_MS = 250; // per bus, between /verify requests
const MAX_PENDING = 2; // /verify requests in flight at once
const REPEAT_AFTER_MS = 5000; // don't repeat "bus seen" / "not your bus" more often than this

const COLORS: Record<string, string> = { checking: "#ffd400", yes: "#00e676", no: "#ff1744", unsure: "#ff9100" };
const LABELS: Record<string, string> = { checking: "Шалгаж байна", yes: "ТАНЫ АВТОБУС", no: "Биш", unsure: "Итгэлгүй" };

function draw(canvas: HTMLCanvasElement, video: HTMLVideoElement, tracks: Track[]): void {
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
}

export default function BusCamera({ stopId, route, foundSpeech, onFound, onError }: Props) {
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

      function announce(track: Track): void {
        const now = performance.now();
        if (track.decision === track.announced) {
          return;
        }
        track.announced = track.decision;
        if (track.decision === "yes") {
          stopped = true;
          vibrate([400, 100, 400]);
          say([foundSpeech]);
          onFound();
        } else if (track.decision === "no" && now - lastNoSpoken > REPEAT_AFTER_MS) {
          lastNoSpoken = now;
          vibrate([100, 80, 100]);
          sayPhrase("not_your_bus");
        } else if (track.decision === "unsure") {
          sayPhrase("not_sure");
        }
      }

      function ask(video: HTMLVideoElement, track: Track, now: number): void {
        const crop = signCrop(video, track.box);
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
        const boxes = await detectBuses(video);
        if (stopped) {
          return;
        }
        const now = performance.now();
        tracks = updateTracks(tracks, boxes, now);
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
              ask(video, item, now);
            }
          });
        draw(overlay, video, tracks);
        frames++;
        if (now - fpsStart >= 1000) {
          setFps(Math.round((frames * 1000) / (now - fpsStart)));
          frames = 0;
          fpsStart = now;
        }
        requestAnimationFrame(tick);
      }

      async function start(): Promise<void> {
        // ?video=/test/bus.webm plays a recorded clip instead of the camera (testing, demo video).
        const recorded = new URLSearchParams(window.location.search).get("video");
        if (!recorded) {
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
      <video ref={videoRef} playsInline muted className="camera-video" />
      <canvas ref={overlayRef} className="camera-overlay" aria-hidden="true" />
      <p className="camera-status">
        {status} · {fps} FPS
      </p>
    </div>
  );
}
