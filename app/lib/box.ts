// A box in video pixels, and how much two boxes overlap. No browser or model code in here, so the
// tracker (and its test) never load onnxruntime just to compare boxes.
export interface Box {
  x: number; // left, video pixels
  y: number; // top
  w: number;
  h: number;
  score: number;
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
