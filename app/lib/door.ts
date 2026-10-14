// Where the bus's front door is, as a blind rider needs it: clock direction, steps, "straight ahead".
// The door's place along the bus comes from the door model (lib/doorDetector.ts) when it sees the
// front door, else from geometry (front door ~90% along the bus from its rear).
import type { Box } from "./detector";

const FOV_DEG = 65; // typical phone main camera, across the LONG side of the image (portrait or landscape)
const BUS_HEIGHT_M = 3.0; // UB city buses are ~3 m tall
const CAMERA_HEIGHT_M = 1.3; // phone worn on the chest
const EDGE_PX = 3; // a box this close to the frame edge is cut off by it
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

// fromFront: door centre's distance from the bus's front edge as a share of its length (door model),
// or null to use geometry.
// How far the bus is. Its height in the frame works while the whole bus is in view; up close its
// roof leaves the frame (a chest-height camera loses it at ~4-5 m), so then the bottom edge (wheels on
// the ground) is used with the camera height; with both edges cut off the bus fills the view: close.
export function busDistance(box: Box, frameH: number, focal: number): number {
  const topCut = box.y <= EDGE_PX;
  const bottomCut = box.y + box.h >= frameH - EDGE_PX;
  if (topCut && bottomCut) {
    return CLOSE_M * 0.6;
  }
  if (topCut) {
    const below = box.y + box.h - frameH / 2; // px below the horizon (phone held about level)
    return below > 0 ? (CAMERA_HEIGHT_M * focal) / below : CLOSE_M * 0.6;
  }
  return (focal * BUS_HEIGHT_M) / Math.max(1, box.h);
}

export function guideToDoor(box: Box, frameW: number, frameH: number, frontRight: boolean, fromFront: number | null): DoorGuide {
  const at = fromFront === null ? 1 - DOOR_AT : fromFront;
  let x = frontRight ? box.x + (1 - at) * box.w : box.x + at * box.w;
  // Bus front cut off by the frame edge and no door seen: the door is past that edge, turn toward it.
  const frontCut = frontRight ? box.x + box.w >= frameW - 4 : box.x <= 4;
  if (fromFront === null && frontCut) {
    x = frontRight ? frameW : 0;
  }
  // Same focal length (px) for both axes; the FOV is across the long side, so a phone held upright
  // (720x1280) gets a narrower horizontal view than one held sideways.
  const focal = Math.max(frameW, frameH) / 2 / Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
  const angle = (Math.atan((x - frameW / 2) / focal) * 180) / Math.PI;
  const distanceM = busDistance(box, frameH, focal);
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
