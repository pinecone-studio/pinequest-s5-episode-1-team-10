"use client";

// VoiceOver-style screen for blind riders: the whole screen is one touch surface.
//   swipe right / left  -> next / previous option, read aloud (Mongolian TTS)
//   one tap             -> read the current option again
//   double tap          -> choose it (with nothing chosen yet: the screen's main action)
// Keyboard (desktop testing, Bluetooth keyboards): arrows move, Enter/Space choose, R repeats.
// Options are also real buttons with labels, so the phone's own screen reader can use them.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { phrase, say, unlockAudio, vibrate } from "../lib/speech";

export interface MenuItem {
  id: string;
  label: string; // shown and, unless speech is given, spoken
  speech?: string[]; // what to say when this option is reached, if not just the label
  onActivate: () => void;
}

interface Props {
  items: MenuItem[];
  primary?: number; // option a double tap chooses before any is reached; none = just give the hint
  children?: ReactNode; // shown inside the touch surface (plan card, camera)
}

const SWIPE_PX = 40;
const DOUBLE_TAP_MS = 350;

export default function VoiceMenu({ items, primary, children }: Props) {
  const [index, setIndexState] = useState(-1); // -1: nothing reached yet
  // Fast swipes arrive before React re-renders, so the live position is kept in a ref too.
  const at = useRef(-1);
  function setIndex(i: number): void {
    at.current = i;
    setIndexState(i);
  }
  const down = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(function () {
    return function () {
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
    };
  }, []);

  function speak(i: number): void {
    const item = items[i];
    say(item.speech ?? [item.label]);
  }

  function move(step: number): void {
    if (!items.length) {
      say([phrase("wait")]);
      return;
    }
    // Stops at the ends like VoiceOver; a double vibration says "no more options".
    const next = Math.min(items.length - 1, Math.max(0, at.current + step));
    if (next === at.current) {
      vibrate([20, 60, 20]);
      speak(next);
      return;
    }
    vibrate([15]);
    setIndex(next);
    speak(next);
  }

  function activate(): void {
    const i = at.current >= 0 ? at.current : primary;
    if (i === undefined || !items[i]) {
      say([phrase(items.length ? "choose_hint" : "wait")]);
      return;
    }
    vibrate([40]);
    items[i].onActivate();
  }

  function repeat(): void {
    if (at.current >= 0 && items[at.current]) {
      speak(at.current);
    } else {
      say([phrase(items.length ? "choose_hint" : "wait")]);
    }
  }

  function onPointerDown(e: PointerEvent): void {
    unlockAudio();
    down.current = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: PointerEvent): void {
    const start = down.current;
    down.current = null;
    if (!start) {
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      move(dx > 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) > SWIPE_PX || Math.abs(dy) > SWIPE_PX) {
      return; // a vertical swipe: ignored for now
    }
    const now = e.timeStamp; // ms, same clock for both taps
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
      activate();
    } else {
      lastTap.current = now;
      tapTimer.current = setTimeout(repeat, DOUBLE_TAP_MS);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      move(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      move(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      activate();
    } else if (e.key === "r" || e.key === "R") {
      repeat();
    } else {
      return;
    }
    e.preventDefault();
  }

  const current = index >= 0 ? items[index] : undefined;
  return (
    <div
      className="voice-menu"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      aria-label="Шудрах, товших талбай"
    >
      {children}
      <p className="voice-current" aria-hidden="true">
        {current ? current.label : items.length ? "→ шудрах · 2× товших" : "…"}
      </p>
      <ul className="voice-items">
        {items.map(function (item, i) {
          return (
            <li key={item.id}>
              <button
                className={i === index ? "voice-item focused" : "voice-item"}
                aria-label={item.label}
                tabIndex={-1}
                // Only clicks from a screen reader or keyboard (detail 0) choose directly; finger taps
                // are handled by the surface so one tap reads, two taps choose.
                onClick={function (e) {
                  if (e.detail === 0) {
                    setIndex(i);
                    item.onActivate();
                  }
                }}
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
