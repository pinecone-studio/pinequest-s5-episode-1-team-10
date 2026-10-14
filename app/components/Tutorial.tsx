"use client";

// First-use lesson, all spoken: the best headphones, how to wear the phone, then practice the two
// gestures every screen uses (swipe right, double tap) and check left/right ears with the door beacon.
// One tap repeats the current step; a double tap skips a step that isn't waiting for practice.
// Plays once per phone (localStorage); Help -> "Заавар дахин сонсох" replays it. ?tutorial forces it.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { aimBeacon, startBeacon, stopBeacon } from "../lib/beacon";
import { phrase, say, stopSpeaking, unlockAudio, vibrate, type PhraseKey } from "../lib/speech";
import { DOUBLE_TAP_MS, SWIPE_PX } from "./VoiceMenu";

type Gesture = "right" | "left" | "tap" | "double";

interface Lesson {
  key: PhraseKey;
  title: string;
  wait?: Gesture; // practice: the step ends only when the rider does this
  beacon?: number; // play the door beacon from this angle (degrees, + = right) after speaking
}

const LESSONS: Lesson[] = [
  { key: "learn_welcome", title: "Сайн байна уу" },
  { key: "learn_headphones", title: "Ясаар дамжуулдаг чихэвч хамгийн сайн" },
  { key: "learn_wear", title: "Утсаа цээжиндээ зүүнэ, камер урагшаа" },
  { key: "learn_swipe", title: "Баруун тийш шудраарай →", wait: "right" },
  { key: "learn_double", title: "Хоёр товшоорой ● ●", wait: "double" },
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
}

export default function Tutorial({ onDone }: Props) {
  const [at, setAt] = useState(0);
  const step = useRef(0);
  const waiting = useRef<Gesture | null>(null);
  const run = useRef(0); // bumped on every step start: older speech/beacon chains stop
  const down = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beaconTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = useRef(false);

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
    if (step.current + 1 >= LESSONS.length) {
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
    const lesson = LESSONS[i];
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
    const lesson = LESSONS[step.current];
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
    const runs = run; // a counter, not a DOM node: the cleanup must bump the live value
    play(0);
    return function () {
      runs.current++;
      stopBeacon();
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
      if (beaconTimer.current) {
        clearTimeout(beaconTimer.current);
      }
    };
    // play() reads refs only; run the lesson once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const keys: Record<string, Gesture> = { ArrowRight: "right", ArrowLeft: "left", Enter: "double", " ": "double", r: "tap", R: "tap" };
    const g = keys[e.key];
    if (g) {
      e.preventDefault();
      unlockAudio();
      gesture(g);
    }
  }

  const lesson = LESSONS[at];
  return (
    <div
      className="voice-menu tutorial"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      aria-label="Заавар: шудрах, товших талбай"
    >
      <p className="tutorial-step" aria-hidden="true">
        {at + 1} / {LESSONS.length}
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
          if (e.pointerType === "mouse") {
            e.stopPropagation();
            finish();
          }
        }}
        onClick={function (e) {
          if (e.detail === 0) {
            finish();
          }
        }}
      >
        Алгасах
      </button>
    </div>
  );
}
