// Where the bus's front door is, as a blind rider needs it: clock direction, steps, "straight ahead".
// ponytail: geometry from the bus box until the fine-tuned model has a "door" class.
import type { Box } from "./detector";

const HFOV_DEG = 65; // typical phone main camera, horizontal field of view
const BUS_HEIGHT_M = 3.0; // UB city buses are ~3 m tall
const STEP_M = 0.7;
const DOOR_AT = 0.9; // front door centre, as a share of the bus length from its rear (tov_nomyn_san_1.png: 0.85-0.97)
const AHEAD_DEG = 8; // door this close to straight ahead counts as "in front of you"
const CLOSE_M = 2.5;

export interface DoorGuide {
  angle: number; // degrees, + = to the right
  clock: number; // 9..3, 12 = straight ahead
  steps: number; // 1..15
  distanceM: number;
  ahead: boolean;
  close: boolean;
  x: number; // door position in the frame, px (for the overlay)
}

// At a UB kerbside stop (right-hand traffic) a rider facing the road sees buses arrive from the left,
// so the front door is on their right. The bus's own movement overrides this when it's known.
export function frontIsRight(vx: number, box: Box): boolean {
  return Math.abs(vx) > box.w * 0.0002 ? vx > 0 : true; // vx in px/ms; moving buses tell us their front
}

export function guideToDoor(box: Box, frameW: number, frontRight: boolean): DoorGuide {
  const x = frontRight ? box.x + DOOR_AT * box.w : box.x + (1 - DOOR_AT) * box.w;
  const half = (HFOV_DEG / 2) * (Math.PI / 180);
  const angle = (Math.atan(((x - frameW / 2) / (frameW / 2)) * Math.tan(half)) * 180) / Math.PI;
  const focal = frameW / 2 / Math.tan(half);
  const distanceM = (focal * BUS_HEIGHT_M) / Math.max(1, box.h);
  const hours = Math.max(-3, Math.min(3, Math.round(angle / 30)));
  return {
    angle,
    clock: hours === 0 ? 12 : hours > 0 ? hours : 12 + hours,
    steps: Math.max(1, Math.min(15, Math.round(distanceM / STEP_M))),
    distanceM,
    ahead: Math.abs(angle) < AHEAD_DEG,
    close: distanceM < CLOSE_M,
    x,
  };
}
