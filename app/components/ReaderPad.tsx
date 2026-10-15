"use client";

// The reader's touch surface, with the same timing as the bus screens (VoiceMenu):
//   double tap          -> the main action (take the photo now / pause / play)
//   swipe right / left  -> next / previous sentence
//   one tap             -> where am I (what the reader is doing, which sentence)
//   press and hold      -> speak a command ("дараагийн хуудас", "хурдан", "буцах"...)
// Keyboard (desktop testing, Bluetooth keyboards): Space/Enter, arrows, W = where, hold V = speak.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { unlockAudio, vibrate } from "../lib/speech";
import { DOUBLE_TAP_MS, HOLD_MS, SWIPE_PX } from "./VoiceMenu";

interface Props {
  onTouch: () => void; // every finger down, inside the touch (iPhones only start sound from one)
  onDoubleTap: () => void;
  onSwipe: (direction: 1 | -1) => void;
  onTap: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  children?: ReactNode;
}

export default function ReaderPad({ onTouch, onDoubleTap, onSwipe, onTap, onHoldStart, onHoldEnd, children }: Props) {
  const down = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);

  useEffect(function () {
    return function () {
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
      }
    };
  }, []);

  function cancelHold(): void {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function onPointerDown(e: PointerEvent): void {
    // Keep the finger even if it slides off the pad (iPhone drops the gesture otherwise, so a hold never ends).
    const el = e.currentTarget;
    if (el instanceof HTMLElement) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // the gesture still works while the finger stays on the pad
      }
    }
    unlockAudio();
    onTouch();
    down.current = { x: e.clientX, y: e.clientY };
    cancelHold();
    holdTimer.current = setTimeout(function () {
      holdTimer.current = null;
      holding.current = true;
      vibrate([30]);
      onHoldStart();
    }, HOLD_MS);
  }

  function onPointerMove(e: PointerEvent): void {
    const start = down.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SWIPE_PX / 2) {
      cancelHold(); // a swipe
    }
  }

  function onPointerUp(e: PointerEvent): void {
    cancelHold();
    if (holding.current) {
      holding.current = false;
      down.current = null;
      onHoldEnd();
      return; // a hold is never also a tap
    }
    const start = down.current;
    down.current = null;
    if (!start) {
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      vibrate([15]);
      onSwipe(dx > 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) > SWIPE_PX || Math.abs(dy) > SWIPE_PX) {
      return;
    }
    const now = e.timeStamp;
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
      vibrate([40]);
      onDoubleTap();
    } else {
      lastTap.current = now;
      tapTimer.current = setTimeout(onTap, DOUBLE_TAP_MS);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "ArrowRight") {
      onSwipe(1);
    } else if (e.key === "ArrowLeft") {
      onSwipe(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      onDoubleTap();
    } else if (e.key === "w" || e.key === "W") {
      onTap();
    } else if ((e.key === "v" || e.key === "V") && !e.repeat) {
      onHoldStart();
    } else {
      return;
    }
    e.preventDefault();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      onHoldEnd();
    }
  }

  return (
    <div
      className="voice-menu reader-pad"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      aria-label="Шудрах, товших талбай"
    >
      {children}
    </div>
  );
}
