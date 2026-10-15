// SOS by touch: two fingers held on the screen for SOS_HOLD_MS. No microphone, no network, on any screen.
// One finger stays what it was (tap, swipe, hold to talk), so SOS can never be a normal gesture by
// accident. At SOS_HOLD_MS a loud tone says "armed, let go now"; lifting the fingers then fires it from
// inside the lift, which phones accept as a tap (they only open the dialer / SMS app from a tap).
import { cue } from "./speech";

export const SOS_HOLD_MS = 1200;
const STALE_MS = 8000;
const SOS_MOVE_PX = 40; // fingers sliding further than this = a pinch or swipe, not SOS

export interface SosPointer {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface SosHold {
  // true: two or more fingers are down, so this touch belongs to SOS (the caller drops its own gesture)
  down: (e: SosPointer) => boolean;
  move: (e: SosPointer) => void;
  // true: the lift belonged to a two-finger touch and is not a tap
  up: (e: SosPointer) => boolean;
  cancel: () => void;
  // what to do when it fires (set after every render, so it is never stale)
  setHandler: (onFire: (() => void) | undefined) => void;
}

export function createSosHold(): SosHold {
  let onFire: (() => void) | undefined;
  const points = new Map<number, { x: number; y: number; at: number }>();
  let multi = false;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stopTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    down: function (e) {
      const now = Date.now();
      // A finger whose lift event was lost (phones sometimes drop it) must never count as a second finger.
      points.forEach(function (item, id) {
        if (now - item.at > STALE_MS) {
          points.delete(id);
        }
      });
      points.set(e.pointerId, { x: e.clientX, y: e.clientY, at: now });
      if (points.size < 2) {
        return multi;
      }
      multi = true;
      armed = false;
      stopTimer();
      timer = setTimeout(function () {
        timer = null;
        armed = true;
        cue("sos", [300, 100, 300, 100, 300]);
      }, SOS_HOLD_MS);
      return true;
    },
    move: function (e) {
      const start = points.get(e.pointerId);
      if (multi && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SOS_MOVE_PX) {
        stopTimer();
        armed = false;
      }
    },
    up: function (e) {
      points.delete(e.pointerId);
      if (!multi) {
        return false;
      }
      stopTimer();
      if (points.size === 0) {
        const fire = armed;
        multi = false;
        armed = false;
        if (fire && onFire) {
          onFire();
        }
      }
      // A finger lifted before the tone stopped the timer above (never armed); after the tone, fingers
      // never lift at the same instant, so the first lift keeps it armed and the last one fires.
      return true;
    },
    setHandler: function (handler) {
      onFire = handler;
    },
    cancel: function () {
      points.clear();
      multi = false;
      armed = false;
      stopTimer();
    },
  };
}
