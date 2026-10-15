// Constant-velocity Kalman filter, one axis at a time: centre, size, and their speeds.
// A covered bus is matched to where this says the box will be, not to where it was last seen.

export interface Axis {
  pos: number;
  vel: number;
  p00: number;
  p01: number;
  p11: number;
}

export interface Motion {
  cx: Axis;
  cy: Axis;
  w: Axis;
  h: Axis;
}

const R = 25; // measurement noise, px^2 (about 5 px)
const Q_POS = 1; // process noise on position, px^2 per ms
const Q_VEL = 1e-6; // process noise on velocity

function axis(pos: number, pPos: number, pVel: number): Axis {
  return { pos: pos, vel: 0, p00: pPos, p01: 0, p11: pVel };
}

export function motionFromBox(box: { x: number; y: number; w: number; h: number }): Motion {
  return {
    cx: axis(box.x + box.w / 2, 100, 1),
    cy: axis(box.y + box.h / 2, 100, 1),
    w: axis(box.w, 100, 0.01),
    h: axis(box.h, 100, 0.01),
  };
}

export function predictAxis(a: Axis, dt: number): Axis {
  return {
    pos: a.pos + a.vel * dt,
    vel: a.vel,
    p00: a.p00 + 2 * dt * a.p01 + dt * dt * a.p11 + Q_POS * dt,
    p01: a.p01 + dt * a.p11,
    p11: a.p11 + Q_VEL * dt,
  };
}

export function updateAxis(a: Axis, measured: number): Axis {
  const innov = measured - a.pos;
  const scale = a.p00 + R;
  const kPos = a.p00 / scale;
  const kVel = a.p01 / scale;
  return {
    pos: a.pos + kPos * innov,
    vel: a.vel + kVel * innov,
    p00: Math.max(1e-3, (1 - kPos) * a.p00),
    p01: (1 - kPos) * a.p01,
    p11: Math.max(1e-8, a.p11 - kVel * a.p01),
  };
}

export function predictMotion(m: Motion, dt: number): Motion {
  if (dt <= 0) {
    return m;
  }
  return {
    cx: predictAxis(m.cx, dt),
    cy: predictAxis(m.cy, dt),
    w: predictAxis(m.w, dt),
    h: predictAxis(m.h, dt),
  };
}

export function updateMotion(m: Motion, box: { x: number; y: number; w: number; h: number }): Motion {
  return {
    cx: updateAxis(m.cx, box.x + box.w / 2),
    cy: updateAxis(m.cy, box.y + box.h / 2),
    w: updateAxis(m.w, box.w),
    h: updateAxis(m.h, box.h),
  };
}
