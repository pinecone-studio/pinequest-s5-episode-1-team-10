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
export function signCrop(video: HTMLVideoElement, box: Box, others: Box[]): string | null {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const w = Math.min(video.videoWidth - x, box.w);
  const h = Math.min(video.videoHeight - y, box.h * SIGN_PART);
  if (w < MIN_BUS_WIDTH || h < 20 || !canvas) {
    return null;
  }
  const scale = Math.min(1, MAX_WIDTH / w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(video, x, y, w, h, 0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  others.forEach(function (item) {
    ctx.fillRect((item.x - x) * scale, (item.y - y) * scale, item.w * scale, item.h * scale);
  });
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}
