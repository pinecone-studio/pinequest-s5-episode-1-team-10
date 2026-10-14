// Steadier, truer walking guidance from noisy phone sensors.
// - GPS in a city is off by 5-30 m and jumps: a small Kalman filter at walking pace (position in metres
//   around the stop) averages fixes by their accuracy and drops jumps that can't be walked.
// - A phone compass is pulled off by buses, cars and steel: while the rider walks straight, the GPS
//   course is the true walking direction, and the chest-worn camera faces it, so the compass's error
//   is learnt from it and corrected. With no compass, the GPS course itself gives the direction.

export interface Fix {
  lat: number;
  lon: number;
  accuracy: number; // m, 1 sigma-ish (Geolocation API)
  heading: number | null; // GPS course, degrees from north (null/NaN when standing)
  speed: number | null; // m/s
  t: number; // ms
}

const MAX_ACCURACY_M = 60; // worse fixes are ignored
const WALK_NOISE = 1.5; // m/s: how fast the true position can drift between fixes
const GATE = 3; // a fix further than 3 sigma from the prediction is a jump
const COURSE_MIN_SPEED = 0.7; // m/s: below this the GPS course is noise
const COURSE_MAX_ACCURACY = 25;
const BIAS_LIMIT = 60; // a bigger compass-course gap is the rider turning/sidestepping, not compass error

const R = Math.PI / 180;

export class PositionFilter {
  private x = 0; // m east of the origin
  private y = 0; // m north
  private p = -1; // variance, m^2 (-1: no fix yet)
  private t = 0;
  private rejected = 0;
  private vx = 0; // m/s, from the last GPS course + speed (0 when standing / unknown)
  private vy = 0;

  constructor(
    private originLat: number,
    private originLon: number,
  ) {}

  // Returns true if the fix was used.
  update(f: Fix): boolean {
    if (!(f.accuracy > 0) || f.accuracy > MAX_ACCURACY_M) {
      return false;
    }
    const zx = (f.lon - this.originLon) * R * Math.cos(this.originLat * R) * 6371000;
    const zy = (f.lat - this.originLat) * R * 6371000;
    const r = f.accuracy * f.accuracy;
    if (this.p < 0) {
      this.x = zx;
      this.y = zy;
      this.p = r;
      this.t = f.t;
      return true;
    }
    const dt = Math.max(0, (f.t - this.t) / 1000);
    // Predict: the rider kept walking the way the GPS said (removes the lag of plain averaging).
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const p = this.p + (WALK_NOISE * dt) * (WALK_NOISE * dt);
    const dx = zx - this.x;
    const dy = zy - this.y;
    const course = courseHeading(f);
    this.vx = course === null ? 0 : (f.speed as number) * Math.sin(course * R);
    this.vy = course === null ? 0 : (f.speed as number) * Math.cos(course * R);
    // Several rejections in a row: the rider really is there (or our estimate is stale): accept.
    if (dx * dx + dy * dy > GATE * GATE * (p + r) && this.rejected < 3) {
      this.rejected++;
      this.p = p;
      this.t = f.t;
      return false;
    }
    this.rejected = 0;
    const k = p / (p + r);
    this.x += k * dx;
    this.y += k * dy;
    this.p = (1 - k) * p;
    this.t = f.t;
    return true;
  }

  ready(): boolean {
    return this.p >= 0;
  }

  distance(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  // m, how unsure the position is (1 sigma)
  sigma(): number {
    return Math.sqrt(Math.max(0, this.p));
  }

  // Degrees from north, from the rider to the origin (the stop).
  bearingToOrigin(): number {
    return ((Math.atan2(-this.x, -this.y) / R) % 360 + 360) % 360;
  }
}

function fold(deg: number): number {
  return ((((deg % 360) + 540) % 360) - 180);
}

export class CompassCorrection {
  private s = 0;
  private c = 0;
  private n = 0;

  // Learn from one moment of walking: compass heading vs GPS course.
  learn(compass: number, f: Fix): void {
    if (f.heading === null || Number.isNaN(f.heading) || f.speed === null || f.speed < COURSE_MIN_SPEED || f.accuracy > COURSE_MAX_ACCURACY) {
      return;
    }
    const gap = fold(f.heading - compass);
    if (Math.abs(gap) > BIAS_LIMIT) {
      return;
    }
    const w = Math.min(0.3, 1 / (this.n + 1)); // quick at first, then a steady average
    this.s = (1 - w) * this.s + w * Math.sin(gap * R);
    this.c = (1 - w) * this.c + w * Math.cos(gap * R);
    this.n++;
  }

  // Degrees to add to the compass (0 until learnt from at least a few seconds of walking).
  offset(): number {
    return this.n >= 3 ? Math.atan2(this.s, this.c) / R : 0;
  }

  apply(compass: number): number {
    return (((compass + this.offset()) % 360) + 360) % 360;
  }
}

// The GPS course as a heading, when the rider is walking fast enough for it to mean something.
export function courseHeading(f: Fix): number | null {
  return f.heading !== null && !Number.isNaN(f.heading) && f.speed !== null && f.speed >= COURSE_MIN_SPEED && f.accuracy <= COURSE_MAX_ACCURACY
    ? f.heading
    : null;
}
