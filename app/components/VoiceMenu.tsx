"use client";

// VoiceOver-style screen for blind riders: the whole screen is one touch surface.
//   swipe right / left  -> next / previous option, read aloud (Mongolian TTS)
//   one tap             -> read the current option again
//   double tap          -> choose it (with nothing chosen yet: the screen's main action)
//   press and hold      -> talk to the voice assistant while holding, release when done; the same
//                          on every screen, so it's never confused with choosing an option
// Keyboard (desktop testing, Bluetooth keyboards): arrows move, Enter/Space choose, R repeats.
// Options are also real buttons with labels, so the phone's own screen reader can use them.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { phrase, say, sayAfter, unlockAudio, vibrate } from "../lib/speech";

export interface MenuItem {
  id: string;
  label: string; // shown and, unless speech is given, spoken
  speech?: string[]; // what to say when this option is reached, if not just the label
  onActivate: () => void;
}

interface Props {
  items: MenuItem[];
  primary?: number; // option a double tap chooses before any is reached; none = just give the hint
  menuId?: string; // a different value = a different menu on the same screen (SOS): start from its top again
  onHoldStart?: () => void; // finger held still HOLD_MS: start listening
  onHoldEnd?: () => void; // finger lifted after a hold: stop listening
  intro?: boolean; // read the options out when the screen (or menu) opens, after its message
  children?: ReactNode; // shown inside the touch surface (plan card, camera)
}

export const SWIPE_PX = 40;
export const DOUBLE_TAP_MS = 350;
export const HOLD_MS = 500;

// The gesture hint follows the options only the first few times; after that the rider knows it.
let hintsLeft = 3;

export default function VoiceMenu({ items, primary, menuId, onHoldStart, onHoldEnd, intro, children }: Props) {
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
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);

  useEffect(function () {
    return function () {
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
    };
  }, []);

  // Everything on the screen is spoken: after the screen's own message, what can be done here.
  const labels = items
    .map(function (item) {
      return item.label;
    })
    .join("|");
  const introduced = useRef(""); // React may run the effect twice (dev): say the options once
  useEffect(
    function () {
      if (!intro || !labels || introduced.current === menuId + labels) {
        return;
      }
      introduced.current = menuId + labels;
      const texts = [phrase("options_intro")].concat(labels.split("|"));
      if (hintsLeft > 0) {
        hintsLeft--;
        texts.push(phrase("options_hint"));
      }
      sayAfter(texts);
    },
    // once per screen (VoiceMenu is keyed by step) and per menu on it (SOS); not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menuId, intro],
  );

  // A new menu on the same screen (the screen itself, e.g. the camera, keeps running): the next
  // gesture starts from its top.
  const menuSeen = useRef(menuId);
  function syncMenu(): void {
    if (menuSeen.current !== menuId) {
      menuSeen.current = menuId;
      setIndex(-1);
    }
  }

  function speak(i: number): void {
    const item = items[i];
    say(item.speech ?? [item.label]);
  }

  function move(step: number): void {
    syncMenu();
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
    syncMenu();
    const i = at.current >= 0 ? at.current : primary;
    if (i === undefined || !items[i]) {
      say([phrase(items.length ? "choose_hint" : "wait")]);
      return;
    }
    vibrate([40]);
    items[i].onActivate();
  }

  function repeat(): void {
    syncMenu();
    if (at.current >= 0 && items[at.current]) {
      speak(at.current);
    } else {
      say([phrase(items.length ? "choose_hint" : "wait")]);
    }
  }

  function cancelHold(): void {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function onPointerDown(e: PointerEvent): void {
    unlockAudio();
    down.current = { x: e.clientX, y: e.clientY };
    cancelHold();
    if (onHoldStart) {
      holdTimer.current = setTimeout(function () {
        holdTimer.current = null;
        holding.current = true;
        vibrate([30]);
        onHoldStart();
      }, HOLD_MS);
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const start = down.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SWIPE_PX / 2) {
      cancelHold(); // it's a swipe
    }
  }

  function onPointerUp(e: PointerEvent): void {
    cancelHold();
    if (holding.current) {
      holding.current = false;
      down.current = null;
      if (onHoldEnd) {
        onHoldEnd();
      }
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
    } else if ((e.key === "v" || e.key === "V") && !e.repeat && onHoldStart) {
      onHoldStart(); // desktop testing: hold V = hold the screen
    } else {
      return;
    }
    e.preventDefault();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if ((e.key === "v" || e.key === "V") && onHoldEnd) {
      e.preventDefault();
      onHoldEnd();
    }
  }

  const current = index >= 0 ? items[index] : undefined;
  return (
    <div
      className="voice-menu"
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
      <p className="voice-current" aria-hidden="true">
        {current ? current.label : items.length ? "→ шудрах · 2× товших · дараад барих = асуух" : "…"}
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
