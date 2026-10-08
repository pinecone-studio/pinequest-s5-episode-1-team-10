// Cuts the route-sign area out of a bus box and encodes it for /verify.
import type { Box } from "./detector";

const SIGN_PART = 0.5; // ponytail: top half of the bus box; replaced by the route_sign class once trained
const MAX_SIDE = 640; // the server shrinks bigger crops anyway
export const MIN_BUS_WIDTH = 120; // px; smaller buses are too far to read

const canvas = typeof document === "undefined" ? null : document.createElement("canvas");

export function signCrop(video: HTMLVideoElement, box: Box): string | null {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const w = Math.min(video.videoWidth - x, box.w);
  const h = Math.min(video.videoHeight - y, box.h * SIGN_PART);
  if (w < MIN_BUS_WIDTH || h < 20 || !canvas) {
    return null;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(video, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}
