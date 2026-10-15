"use client";

// First-use lesson, all spoken: the best headphones, how to wear the phone, then practice the
// gestures every screen uses (swipe right, double tap, press-and-hold to talk, two fingers held = SOS,
// which only plays the tone here and calls nobody) and check left/right ears with the door beacon.
// One tap repeats the current step; a double tap skips a step that isn't waiting for practice.
// Plays once per phone (localStorage); Help -> "Заавар дахин сонсох" replays it. ?tutorial forces it.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { aimBeacon, startBeacon, stopBeacon } from "../lib/beacon";
import { phrase, say, stopSpeaking, unlockAudio, vibrate, type PhraseKey } from "../lib/speech";
import type { Mode } from "../lib/mode";
import { createSosHold } from "../lib/sosHold";
import { DOUBLE_TAP_MS, HOLD_MS, SWIPE_PX } from "./VoiceMenu";

type Gesture = "right" | "left" | "tap" | "double" | "hold" | "sos";

interface Lesson {
  key: PhraseKey;
  title: string;
  wait?: Gesture; // practice: the step ends only when the rider does this
  beacon?: number; // play the door beacon from this angle (degrees, + = right) after speaking
  only?: Mode; // a step for one mode only (the screen-reader mode has a button instead of the gesture)
}

const LESSONS: Lesson[] = [
  { key: "learn_welcome", title: "Сайн байна уу" },
  { key: "learn_headphones", title: "Ясаар дамжуулдаг чихэвч хамгийн сайн" },
  { key: "learn_wear", title: "Утсаа цээжиндээ зүүнэ, камер урагшаа" },
  { key: "learn_swipe", title: "Баруун тийш шудраарай →", wait: "right" },
  { key: "learn_double", title: "Хоёр товшоорой ● ●", wait: "double" },
  { key: "learn_hold", title: "Дараад барьж ярина = асуух", wait: "hold" },
  { key: "learn_sos", title: "Тусламж: хоёр хуруугаар барина", wait: "sos", only: "voice" },
  { key: "learn_sos_sr", title: "Тусламж: Яаралтай тусламж товч", only: "sr" },
  { key: "learn_sound_right", title: "Баруун чих ▶", beacon: 40 },
  { key: "learn_sound_left", title: "◀ Зүүн чих", beacon: -40 },
  { key: "learn_beacon", title: "Хоёр чихэнд адилхан = хаалга урд тань", beacon: 0 },
  { key: "learn_done", title: "Бэлэн боллоо" },
];
const BEACON_MS = 2500;
const LEARNED_KEY = "avtobus.learned";

export function tutorialNeeded(): boolean {
  const q = new URLSearchParams(window.location.search);
  if (q.has("tutorial")) {
    return true;
  }
  if (q.has("notutorial")) {
    return false;
  }
  try {
    return window.localStorage.getItem(LEARNED_KEY) !== "1";
  } catch {
    return true; // storage blocked: better to teach again than never
  }
}

function markLearned(): void {
  try {
    window.localStorage.setItem(LEARNED_KEY, "1");
  } catch {
    // storage blocked: the lesson just plays again next time
  }
}

interface Props {
  onDone: () => void;
  mode: Mode; // "sr": a screen reader takes the gestures, so only the spoken tips and the ear check
}

export default function Tutorial({ onDone, mode }: Props) {
  const lessons = LESSONS.filter(function (item) {
    // a screen reader takes the gestures: no practice steps, only the spoken tips and the ear check
    return (!item.only || item.only === mode) && (mode !== "sr" || !item.wait);
  });
  const [at, setAt] = useState(0);
  const step = useRef(0);
  const waiting = useRef<Gesture | null>(null);
  const run = useRef(0); // bumped on every step start: older speech/beacon chains stop
  const down = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beaconTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  // Two fingers held until the tone, then lifted: practice only, nobody is called.
  const [sosHold] = useState(createSosHold);

  function finish(): void {
    if (finished.current) {
      return;
    }
    finished.current = true;
    run.current++;
    stopBeacon();
    stopSpeaking();
    markLearned();
    onDone();
  }

  function next(): void {
    if (step.current + 1 >= lessons.length) {
      finish();
    } else {
      play(step.current + 1);
    }
  }

  function play(i: number): void {
    const mine = ++run.current;
    step.current = i;
    waiting.current = null;
    setAt(i);
    stopBeacon();
    if (beaconTimer.current) {
      clearTimeout(beaconTimer.current);
    }
    const lesson = lessons[i];
    say([phrase(lesson.key)]).then(function () {
      if (mine !== run.current) {
        return;
      }
      if (lesson.wait) {
        waiting.current = lesson.wait;
      } else if (lesson.beacon !== undefined) {
        aimBeacon(lesson.beacon);
        startBeacon();
        beaconTimer.current = setTimeout(function () {
          stopBeacon();
          if (mine === run.current) {
            next();
          }
        }, BEACON_MS);
      } else {
        next();
      }
    });
  }

  function gesture(g: Gesture): void {
    const lesson = lessons[step.current];
    if (waiting.current) {
      if (g === waiting.current) {
        waiting.current = null;
        const mine = ++run.current;
        vibrate([40, 60, 40]);
        say([phrase("learn_good")]).then(function () {
          if (mine === run.current) {
            next();
          }
        });
      } else if (g === "tap") {
        play(step.current); // hear the instruction again
      } else {
        vibrate([20, 60, 20]);
        const mine = ++run.current;
        say([phrase("learn_again"), phrase(lesson.key)]).then(function () {
          if (mine === run.current) {
            waiting.current = lesson.wait ?? null;
          }
        });
      }
      return;
    }
    if (g === "tap") {
      play(step.current);
    } else if (g === "double" && !lesson.wait) {
      next(); // skip this step
    }
  }

  useEffect(function () {
    sosHold.setHandler(function () {
      gesture("sos");
    });
  });

  useEffect(function () {
    const runs = run; // a counter, not a DOM node: the cleanup must bump the live value
    play(0);
    return function () {
      runs.current++;
      stopBeacon();
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
      }
      if (beaconTimer.current) {
        clearTimeout(beaconTimer.current);
      }
      sosHold.cancel();
    };
    // play() reads refs only; run the lesson once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPointerDown(e: PointerEvent): void {
    unlockAudio();
    if (sosHold.down(e)) {
      // a second finger: SOS practice, not a tap, swipe or hold
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
      held.current = false;
      down.current = null;
      return;
    }
    down.current = { x: e.clientX, y: e.clientY };
    held.current = false;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
    }
    holdTimer.current = setTimeout(function () {
      holdTimer.current = null;
      held.current = true;
      vibrate([30]);
    }, HOLD_MS);
  }

  function onPointerMove(e: PointerEvent): void {
    sosHold.move(e);
    const start = down.current;
    if (start && holdTimer.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SWIPE_PX / 2) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (sosHold.up(e)) {
      down.current = null;
      return; // a lift of a two-finger touch is never a tap
    }
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (held.current) {
      held.current = false;
      down.current = null;
      gesture("hold");
      return;
    }
    const start = down.current;
    down.current = null;
    if (!start) {
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      gesture(dx > 0 ? "right" : "left");
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
      gesture("double");
    } else {
      lastTap.current = now;
      tapTimer.current = setTimeout(function () {
        gesture("tap");
      }, DOUBLE_TAP_MS);
    }
  }

  // Desktop testing / Bluetooth keyboards, same keys as VoiceMenu.
  function onKeyDown(e: KeyboardEvent): void {
    const keys: Record<string, Gesture> = { ArrowRight: "right", ArrowLeft: "left", Enter: "double", " ": "double", r: "tap", R: "tap", v: "hold", V: "hold", s: "sos", S: "sos" };
    const g = keys[e.key];
    if (g) {
      e.preventDefault();
      unlockAudio();
      gesture(g);
    }
  }

  const lesson = lessons[at];
  return (
    <div
      className="voice-menu tutorial"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      aria-label="Заавар: шудрах, товших талбай"
    >
      <p className="tutorial-step" aria-hidden="true">
        {at + 1} / {lessons.length}
      </p>
      <p className="tutorial-title" aria-live="polite">
        {lesson.title}
      </p>
      <p className="tutorial-text">{phrase(lesson.key)}</p>
      {/* For a sighted helper (mouse) or the phone's screen reader. A finger tap here is just a lesson
          gesture, so a blind rider's double tap can't skip the lesson by accident. */}
      <button
        className="tutorial-skip"
        aria-label="Заавар алгасах"
        tabIndex={-1}
        onPointerUp={function (e) {
          if (mode === "sr" || e.pointerType === "mouse") {
            e.stopPropagation(); // with a screen reader the surface takes no gestures: a plain button
          }
          if (e.pointerType === "mouse") {
            finish();
          }
        }}
        onClick={function (e) {
          if (mode === "sr" || e.detail === 0) {
            finish();
          }
        }}
      >
        Алгасах
      </button>
    </div>
  );
}
