// Cuts the route-sign area out of a bus box and encodes it for /verify.
import type { Box } from "./detector";

// ponytail: top 45% of the bus box, replaced by the route_sign class once trained. Route LEDs sit at
// 25-30% of the box height in tov_nomyn_san_*.png; painted fleet numbers ("13-278") at 50%+ are left out.
const SIGN_PART = 0.45;
// Keep resolution: a wide bus-side crop shrunk to 640 px made the LED text unreadable (server caps height).
const MAX_WIDTH = 1600;
export const MIN_BUS_WIDTH = 120; // px; smaller buses are too far to read

const canvas = typeof document === "undefined" ? null : document.createElement("canvas");

// others: other vehicles in the frame; their area is blacked out so their signs can't be read here.
// The crop as a canvas (read on the phone by lib/ocr.ts), or null if the bus is too small / far.
export function signCanvas(video: HTMLVideoElement, box: Box, others: Box[]): HTMLCanvasElement | null {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const w = Math.min(video.videoWidth - x, box.w);
  const h = Math.min(video.videoHeight - y, box.h * SIGN_PART);
  if (w < MIN_BUS_WIDTH || h < 20 || !canvas) {
    return null;
  }
  const scale = Math.min(1, MAX_WIDTH / w);
  // Sizes rounded up (32 px) so the next frames, with a bus box a few pixels different, reuse the same
  // canvas instead of re-allocating it (iPhone Safari reloads a page over its canvas memory limit).
  const cw = Math.ceil((w * scale) / 32) * 32;
  const ch = Math.ceil((h * scale) / 32) * 32;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const sx = cw / w;
  const sy = ch / h;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(video, x, y, w, h, 0, 0, cw, ch);
  ctx.fillStyle = "#000";
  others.forEach(function (item) {
    ctx.fillRect((item.x - x) * sx, (item.y - y) * sy, item.w * sx, item.h * sy);
  });
  return canvas;
}

// The crop as base64 JPEG for the server's OCR (/verify).
export function signCrop(video: HTMLVideoElement, box: Box, others: Box[]): string | null {
  const c = signCanvas(video, box, others);
  return c ? c.toDataURL("image/jpeg", 0.85).split(",")[1] : null;
}
