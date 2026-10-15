"use client";

// Reads printed text aloud: books, newspapers, letters, labels, medicine boxes. The rider points the
// phone at the page; the app says where to move it (and ticks higher as the page comes into view),
// takes the photo itself, then reads sentence by sentence in a Mongolian voice while the rest of the
// page is still being recognised. Everything runs on the phone: free, and offline after the first visit.
//   both modes, same buttons: one big action, up to three more, then Буцах and Дахин сонсох
//   voice mode also: double tap = that big action, swipe = next / previous sentence, one tap = hear it again
//   press and hold: a spoken menu (new page, speed)     iPhone: the finger can slide and the hold still ends
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { serverCaps } from "../lib/api";
import { canListen, enableSpeechmatics, listen as listenToRider } from "../lib/listen";
import { savedMode, saveMode, type Mode } from "../lib/mode";
import { beep, hasClip, phrase, vibrate, type PhraseKey } from "../lib/speech";
import { keepScreenOn } from "../lib/wake";
import { advise, openCamera, quality, type Advice, type Camera } from "../lib/reader/aim";
import { readerCommand, type ReaderCommand } from "../lib/reader/commands";
import { startRemoteLog } from "../lib/reader/remoteLog";
import { analyze, isReady, keepOffline, listen, loadModels, lowMemoryPhone, readPage, synthesize, type Reading, type SpeechStream } from "../lib/reader/engine";
import { AIM_DET } from "../lib/reader/pageOcr";
import { errorTone, loadingSound, pageEndChime, playStream, prompt, releasePlayer, shutter, stopPlayer, tick, unlockPlayer, unsureTone, waitForVoice, type Playing } from "../lib/reader/player";
import { SentenceBuilder, UNCLEAR, type Sentence } from "../lib/reader/sentences";
import { spokenText } from "../lib/reader/speechText";
import ReaderPad from "./ReaderPad";
import type { MenuItem } from "./VoiceMenu";

type Phase = "start" | "aim" | "reading" | "pageEnd";

// Pre-made clips already on the main deploy (the bus app's): the only things that can be said before
// the Mongolian reading voice has loaded. Never the phone's own (Russian) voice.
const CAMERA_WAIT = "Камер бэлдэж байна. Түр хүлээнэ үү.";
const WAIT = "Түр хүлээнэ үү.";
const WAIT_EVERY_MS = 9000;

const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2];
const SPEED_KEY = "avtobus.readSpeed";
const AIM_EVERY_MS = 400;
const GIVE_UP_AIMING_MS = 9000; // text in view this long but never "ready": take the photo anyway
const SAY_EVERY_MS = 2500;

const ADVICE_PHRASE: Record<Advice, PhraseKey | null> = {
  noText: "read_no_text",
  dark: "read_dark_no_light",
  back: "read_back",
  closer: "read_closer",
  left: "read_left",
  right: "read_right",
  up: "read_up",
  down: "read_down",
  still: "read_still",
  ready: null,
};

// Press and hold where the phone can't recognise Mongolian (every iPhone): a short spoken menu of the
// commands the gestures don't cover. Swipe = next / previous, double tap = choose, hold again = close.
interface MenuEntry {
  label: PhraseKey;
  command: ReaderCommand | "close";
}

interface Menu {
  items: MenuEntry[];
  at: number; // -1: nothing chosen yet (only the list was read)
  wasPlaying: boolean; // the reading goes on when the menu closes
}

interface Session {
  sentences: Sentence[];
  builder: SentenceBuilder;
  done: boolean; // the whole page has been recognised
  lines: number; // lines on the page
  unclear: number; // lines that couldn't be read
  index: number; // sentence being read
  voiceWarned: boolean; // the "voice failed" line is said once, not on every retry
  run: number; // bumped on every jump: an older reading loop stops
  paused: boolean;
  playing: Playing | null;
  audio: Map<number, SpeechStream>; // the sentence's voice, made ahead
  ocr: Reading | null;
  wake: (() => void) | null; // a waiting loop: new sentences came, or play was pressed
}

function savedSpeed(): number {
  try {
    const v = Number(window.localStorage.getItem(SPEED_KEY));
    return SPEEDS.indexOf(v) >= 0 ? v : 1;
  } catch {
    return 1;
  }
}

// ?debug=1: what the reader is doing, in the console ("[reader] ...").
function trace(text: string): void {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1") {
    console.log("[reader] " + text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

export default function Reader() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("voice");
  const [phase, setPhaseState] = useState<Phase>("start");
  const [status, setStatus] = useState("");
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [voiceLoad, setVoiceLoad] = useState<number | null>(null); // % of the voice model downloaded
  const [appReading, setAppReading] = useState(true); // false: the Mongolian voice failed, so a screen reader may read the sentence
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const phaseRef = useRef<Phase>("start");
  const modeRef = useRef<Mode>("voice");
  const speedRef = useRef(1);
  const camera = useRef<Camera | null>(null);
  const aimRun = useRef(0);
  const session = useRef<Session | null>(null);
  const talking = useRef<{ stop: () => void } | null>(null);
  const lightOn = useRef(false);
  const menu = useRef<Menu | null>(null);
  const awake = useRef<WakeLock | null>(null);
  const lastSaidKey = useRef<PhraseKey>("read_aim_hint");
  const controlsSaid = useRef(false);
  const introducing = useRef(false);

  // The <video> element is replaced when the screen changes (start -> aiming): whichever one is on
  // the page shows the camera.
  function videoNode(node: HTMLVideoElement | null): void {
    videoRef.current = node;
    if (node && camera.current) {
      camera.current.attach(node);
    }
  }

  function setPhase(p: Phase): void {
    phaseRef.current = p;
    setPhaseState(p);
  }

  function setSpeed(v: number): void {
    speedRef.current = v;
    setSpeedState(v);
    try {
      window.localStorage.setItem(SPEED_KEY, String(v));
    } catch {
      // storage blocked: speed resets next time
    }
  }

  // The aiming screen's <video> (class "reader-video", not the hidden one of the start screen).
  function aimVideoShown(): boolean {
    const v = videoRef.current;
    return Boolean(v && v.isConnected && v.classList.contains("reader-video"));
  }

  // "now": only useful right away (aiming hints): skipped while the Mongolian voice is still loading.
  function say(key: PhraseKey, when?: "wait" | "now"): Promise<void> {
    lastSaidKey.current = key;
    setStatus(phrase(key));
    return prompt(phrase(key), when);
  }

  // Leaving the page: camera off, reading stopped (the worker and its models stay for next time).
  function shutdown(): void {
    aimRun.current++;
    menu.current = null;
    endReading();
    stopPlayer();
    releasePlayer();
    keepScreenOn(false);
    if (camera.current) {
      camera.current.stop();
      camera.current = null;
    }
  }

  useEffect(function () {
    // The camera, the screen staying on and the offline copy only exist on https pages: a link opened
    // as http:// (a tunnel serves both) would otherwise find no camera at all.
    const host = window.location.hostname;
    if (window.location.protocol === "http:" && host !== "localhost" && host !== "127.0.0.1") {
      window.location.replace("https:" + window.location.href.slice(5));
      return;
    }
    startRemoteLog();
    // Online with a speech key on the server (Speechmatics): the rider can say commands on an iPhone too.
    serverCaps().then(function (caps) {
      enableSpeechmatics(caps.speech);
    });
    const stop = listen(function (msg) {
      if (msg.type === "progress" && msg.part === "voice" && msg.total) {
        setVoiceLoad(Math.min(99, Math.round((100 * msg.loaded) / msg.total)));
      } else if (msg.type === "ready" && msg.part === "voice") {
        setVoiceLoad(null);
      } else if (msg.type === "ready" && msg.part === "ocr" && !msg.ok && phaseRef.current === "aim") {
        errorTone(); // tried again on the next frame
        say("read_failed");
      }
    });
    // Coming from the bus screens (a tap already unlocked sound): start at once.
    if (new URLSearchParams(window.location.search).get("from") === "app") {
      begin();
    }
    return function () {
      stop();
      shutdown();
    };
    // begin/shutdown only use refs and state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new screen moves focus to its heading, so VoiceOver / TalkBack says where the rider is.
  useEffect(
    function () {
      if (mode === "sr" && phase !== "start" && headingRef.current) {
        headingRef.current.focus();
      }
    },
    [phase, mode],
  );

  // Keep the sentence being read on screen (for anyone helping, or low vision).
  useEffect(
    function () {
      if (currentRef.current) {
        currentRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [at],
  );

  async function begin(chosen?: Mode): Promise<void> {
    if (phaseRef.current !== "start") {
      return;
    }
    unlockPlayer();
    keepAwake();
    const m = chosen ?? savedMode() ?? "voice";
    modeRef.current = m;
    setMode(m);
    saveMode(m);
    setSpeed(savedSpeed());
    // An iPhone gets the page reader first: aiming needs only that (its directions are pre-made
    // sentences), and the voice's ~300 MB is loaded when a page has been photographed.
    loadModels(lowMemoryPhone() ? ["ocr"] : ["ocr", "voice"]);
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {}); // keep the 50 MB of models
    }
    // The app's one service worker (public/sw.js, registered by components/OfflineClips.tsx in the
    // production build) keeps this page offline; it's told which files this visit used.
    keepOffline(
      ["/read"].concat(
        performance.getEntriesByType("resource").map(function (item) {
          return item.name;
        }),
      ),
    );
    trace("start tapped: " + (modeRef.current === "sr" ? "screen reader" : "voice") + " mode");
    setPhase("aim");
    // Heard at once, before any model is loaded: a blind rider must know the app took the tap.
    const preparing = prompt(CAMERA_WAIT);
    // The aiming screen has its own <video>: wait until it's on the page (a slow phone takes a while).
    for (let i = 0; i < 40 && !aimVideoShown(); i++) {
      await sleep(50);
    }
    const video = videoRef.current;
    if (!video) {
      console.warn("[reader] no video element");
      return;
    }
    try {
      trace("asking for the camera");
      camera.current = await openCamera(video);
      // The screen may have changed again while the phone asked for permission.
      if (videoRef.current) {
        camera.current.attach(videoRef.current);
      }
      trace("camera on: " + video.videoWidth + "x" + video.videoHeight);
    } catch (e) {
      console.warn("[reader] camera failed", e);
      errorTone();
      say(navigator.mediaDevices ? "read_camera_failed" : "read_camera_unavailable");
      return;
    }
    // The welcome is in the Mongolian voice, which may still be downloading: said once it's ready.
    preparing.then(function () {});
    aim(true);
  }

  // Live camera -> advice and ticks, until the page is in view; then the photo.
  // `welcome`: say the welcome once the voice is ready. `quietUntil`: no hints before it's said.
  async function aim(welcome?: boolean, quietUntil?: Promise<void>): Promise<void> {
    const run = ++aimRun.current;
    let quiet = Boolean(quietUntil); // true while something else is being said
    let needWelcome = Boolean(welcome);
    if (quietUntil) {
      quietUntil.then(function () {
        quiet = false;
      });
    }
    let sharpest = 0;
    let steady = 0;
    let textSince = 0;
    let lastAdvice: Advice | null = null;
    let lastSaid = 0;
    let lastWait = performance.now(); // "please wait" was just said when the camera opened
    const debug = new URLSearchParams(window.location.search).get("debug") === "1";
    while (aimRun.current === run) {
      const started = performance.now();
      const cam = camera.current;
      const frame = cam ? await cam.frame(AIM_DET) : null;
      const check = frame ? await analyze(frame) : null;
      if (aimRun.current !== run) {
        return;
      }
      if (!check) {
        // Models still loading (the first visit downloads ~57 MB): the rider hears that, not silence.
        const waited = performance.now();
        if (!isReady("ocr") && waited - lastWait > WAIT_EVERY_MS) {
          lastWait = waited;
          setStatus(phrase("read_loading"));
          prompt(hasClip(WAIT) ? WAIT : phrase("read_loading"), "now");
          loadingSound();
        }
        await sleep(500);
        continue;
      }
      if (needWelcome && (isReady("voice") || hasClip(phrase(modeRef.current === "sr" ? "read_welcome_sr" : "read_welcome")))) {
        needWelcome = false;
        quiet = true;
        say(modeRef.current === "sr" ? "read_welcome_sr" : "read_welcome", "now").then(function () {
          // Voice mode has no screen reader, so the big button is named once. Screen-reader mode
          // already hears it from the welcome, then finds the button by swiping.
          if (modeRef.current === "voice" && aimRun.current === run) {
            return prompt(phrase("read_btn_capture"), "now");
          }
        }).then(function () {
          quiet = false;
        });
      }
      sharpest = Math.max(sharpest * 0.97, check.sharpness);
      let advice = advise(check, sharpest, cam ? cam.minLine : 0.0045);
      if (advice === "dark" && cam && cam.torch && !lightOn.current) {
        lightOn.current = true;
        cam.light(true);
        advice = "noText";
        if (!quiet) {
          say("read_dark", "now");
          lastSaid = performance.now();
        }
      }
      tick(quality(check, advice));
      if (debug) {
        console.log("[reader] aim: " + advice + " " + JSON.stringify(check));
      }
      const now = performance.now();
      textSince = check.lines >= 2 ? textSince || now : 0;
      steady = advice === "ready" ? steady + 1 : 0;
      if (steady >= 2 || (textSince && now - textSince > GIVE_UP_AIMING_MS)) {
        capture();
        return;
      }
      const key = ADVICE_PHRASE[advice];
      if (key && !quiet && (advice !== lastAdvice ? now - lastSaid > SAY_EVERY_MS : now - lastSaid > 2.5 * SAY_EVERY_MS)) {
        lastAdvice = advice;
        lastSaid = now;
        say(key, "now");
      }
      await sleep(Math.max(0, AIM_EVERY_MS - (performance.now() - started)));
    }
  }

  async function capture(): Promise<void> {
    aimRun.current++;
    const cam = camera.current;
    if (!cam) {
      return;
    }
    shutter();
    vibrate([60]);
    const photo = await cam.photo();
    if (lightOn.current) {
      lightOn.current = false;
      cam.light(false);
    }
    // Off while the page is read (minutes): battery and heat. Back on for the next page.
    cam.stop();
    camera.current = null;
    if (!photo) {
      errorTone();
      say("read_failed");
      newPage();
      return;
    }
    startReading(photo);
  }

  // Camera on again (after a page was read) and aiming.
  async function aimAgain(): Promise<void> {
    const video = videoRef.current;
    if (!camera.current && video) {
      try {
        camera.current = await openCamera(video);
      } catch (e) {
        console.warn("[reader] camera failed", e);
        errorTone();
        say(navigator.mediaDevices ? "read_camera_failed" : "read_camera_unavailable");
        return;
      }
    }
    aim();
  }

  function endReading(): void {
    const s = session.current;
    if (s) {
      s.run++;
      if (s.ocr) {
        s.ocr.cancel();
      }
      if (s.playing) {
        s.playing.stop();
      }
      if (s.wake) {
        s.wake();
      }
    }
    session.current = null;
  }

  function startReading(photo: ImageBitmap): void {
    endReading();
    if (!isReady("voice")) {
      loadModels(["voice"]); // a no-op when it's loading already
    }
    const s: Session = {
      sentences: [],
      builder: new SentenceBuilder(),
      done: false,
      lines: 0,
      unclear: 0,
      index: 0,
      voiceWarned: false,
      run: 0,
      paused: false,
      playing: null,
      audio: new Map(),
      ocr: null,
      wake: null,
    };
    session.current = s;
    setSentences([]);
    setAt(0);
    setPaused(false);
    setPhase("reading");
    setStatus(phrase("read_taken"));
    // The shutter and a vibration say the photo was taken; "Уншиж байна" only if the first sentence
    // takes a while (a slow phone), so reading starts the moment it can.
    setTimeout(function () {
      if (session.current === s && s.index === 0 && !s.playing && !s.paused && !introducing.current) {
        prompt(phrase("read_reading"), "now");
      }
    }, 1500);
    s.ocr = readPage(
      photo,
      function (lines, done, _turned, total) {
        if (session.current !== s) {
          return;
        }
        s.lines = total;
        lines.forEach(function (item) {
          if (item.conf < UNCLEAR && item.text.trim()) {
            s.unclear++;
          }
        });
        const more = s.builder.add(lines, done);
        if (more.length) {
          s.sentences = s.sentences.concat(more);
          setSentences(s.sentences);
          // the first sentences' voice is made at once
          for (let i = s.index; i < Math.min(s.index + 2, s.sentences.length); i++) {
            if (s.sentences[i].text) {
              audioFor(s, i, i === s.index);
            }
          }
        }
        if (done) {
          s.done = true;
          s.ocr = null;
        }
        if (s.wake) {
          s.wake();
        }
      },
      function () {
        if (session.current === s) {
          s.done = true;
          if (s.wake) {
            s.wake();
          }
        }
      },
    );
    readFrom(s, 0);
  }

  // The sentence's voice, started now if it wasn't made ahead; null while the voice is still loading.
  function audioFor(s: Session, i: number, urgent: boolean): SpeechStream | null {
    let a = s.audio.get(i) ?? null;
    if (!a) {
      a = synthesize(s.sentences[i].text, urgent);
      if (a) {
        s.audio.set(i, a);
      }
    }
    return a;
  }

  // Reads from sentence i on; any jump (next, previous, new page) starts a new run.
  function readFrom(s: Session, i: number): void {
    if (s.playing) {
      s.playing.stop();
      s.playing = null;
    }
    s.run++;
    s.index = Math.max(0, i);
    setAt(s.index);
    loop(s, s.run);
  }

  async function loop(s: Session, run: number): Promise<void> {
    function alive(): boolean {
      return session.current === s && s.run === run;
    }
    while (alive()) {
      if (s.paused || (s.index >= s.sentences.length && !s.done)) {
        await new Promise<void>(function (resolve) {
          s.wake = resolve;
        });
        s.wake = null;
        continue;
      }
      if (s.index >= s.sentences.length) {
        pageEnd(s);
        return;
      }
      const sentence = s.sentences[s.index];
      const shown = sentence.text || phrase("read_unclear_line");
      // Written before the voice starts, so a missed sentence can be swiped to.
      setStatus(shown);
      // Never the phone's own (Russian) voice: wait for the Mongolian one, with a loading sound.
      if (!isReady("voice")) {
        if (hasClip(phrase("read_voice_wait"))) {
          await prompt(phrase("read_voice_wait"));
        }
        trace("sentence " + s.index + ": waiting for the Mongolian voice");
        const ok = await waitForVoice();
        trace("voice ready: " + ok);
        if (!alive()) {
          return;
        }
        if (!ok) {
          setAppReading(false);
          setStatus(shown);
          if (!s.voiceWarned) {
            s.voiceWarned = true;
            errorTone();
            if (hasClip(phrase("read_voice_failed"))) {
              await prompt(phrase("read_voice_failed"));
            }
            setStatus(shown);
          }
          await sleep(3000);
        } else {
          setAppReading(true);
        }
        if (!ok) {
          continue; // the model is asked to load again
        }
      }
      setAppReading(true);
      // Once, before the first sentence: name the buttons. Clips only, so an iPhone never uses its Russian voice.
      if (modeRef.current === "voice" && !controlsSaid.current && s.index === 0) {
        controlsSaid.current = true;
        const names: PhraseKey[] = ["read_btn_pause", "read_btn_prev", "read_btn_next", "read_btn_back"];
        introducing.current = true;
        try {
          for (let i = 0; i < names.length; i++) {
            if (!alive()) {
              return;
            }
            const line = phrase(names[i]);
            if (hasClip(line)) {
              await prompt(line, "now");
            }
          }
        } finally {
          introducing.current = false;
        }
      }
      // This one first, then the next two are made while it plays.
      const stream = sentence.text ? audioFor(s, s.index, true) : null;
      [1, 2].forEach(function (item) {
        if (s.index + item < s.sentences.length && s.sentences[s.index + item].text) {
          audioFor(s, s.index + item, false);
        }
      });
      if (sentence.unclear) {
        await prompt(phrase("read_unclear_line"));
        if (!alive()) {
          return;
        }
      }
      if (stream) {
        if (sentence.unsure) {
          await unsureTone();
        }
        trace("sentence " + s.index + ": playing as it's made");
        const playing = playStream(stream, speedRef.current);
        s.playing = playing;
        if (s.paused) {
          playing.pause();
        }
        const finished = await playing.done;
        if (!alive() || !finished) {
          return;
        }
        s.playing = null;
      }
      s.audio.delete(s.index);
      s.index++;
      setAt(s.index);
    }
  }

  function pageEnd(s: Session): void {
    setPhase("pageEnd");
    pageEndChime();
    if (s.lines === 0) {
      say("read_none").then(function () {
        if (phaseRef.current === "pageEnd" && session.current === s) {
          newPage();
        }
      });
      return;
    }
    if (s.unclear > 0.3 * s.lines) {
      say(modeRef.current === "sr" ? "read_retake_sr" : "read_retake");
    } else {
      say(modeRef.current === "sr" ? "read_page_end_sr" : "read_page_end");
    }
  }

  function newPage(): void {
    endReading();
    stopPlayer();
    setSentences([]);
    setAt(0);
    setPaused(false);
    setPhase("aim");
    setStatus(phrase("read_aim_hint"));
    aimAgain();
  }

  function togglePause(): void {
    const s = session.current;
    if (!s) {
      return;
    }
    s.paused = !s.paused;
    setPaused(s.paused);
    if (s.paused) {
      if (s.playing) {
        s.playing.pause();
      }
      const current = s.sentences[Math.min(s.index, s.sentences.length - 1)];
      setStatus((current && current.text) || phrase("read_paused"));
    } else {
      const current = s.sentences[Math.min(s.index, s.sentences.length - 1)];
      setStatus((current && current.text) || "");
      if (s.playing) {
        s.playing.resume();
      } else if (s.wake) {
        s.wake();
      }
    }
  }

  function step(direction: 1 | -1): void {
    const s = session.current;
    if (!s || !s.sentences.length) {
      return;
    }
    const last = s.done ? s.sentences.length - 1 : s.sentences.length;
    const target = Math.max(0, Math.min(last, s.index + direction));
    if (phaseRef.current === "pageEnd") {
      setPhase("reading");
    }
    s.paused = false;
    setPaused(false);
    readFrom(s, target);
  }

  // Missed it. While a sentence is playing, say that sentence again. Otherwise repeat the last instruction.
  function hearAgain(): void {
    unlockPlayer();
    const s = session.current;
    if (phaseRef.current === "reading" && s && s.index < s.sentences.length) {
      s.paused = false;
      setPaused(false);
      readFrom(s, s.index);
      return;
    }
    say(lastSaidKey.current);
  }

  async function where(): Promise<void> {
    hearAgain();
  }

  // Says something over the reading: the sentence pauses, then goes on.
  async function pauseForPrompt(speak: () => Promise<void>): Promise<void> {
    const s = session.current;
    const wasReading = s && !s.paused && phaseRef.current === "reading";
    if (s && wasReading) {
      s.run++;
      if (s.playing) {
        s.playing.stop();
        s.playing = null;
      }
    }
    await speak();
    if (s && wasReading && session.current === s && !s.paused) {
      readFrom(s, s.index); // the interrupted sentence again
    }
  }

  function changeSpeed(direction: 1 | -1): void {
    const i = SPEEDS.indexOf(speedRef.current);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + direction))];
    setSpeed(next);
    const text = "Хурд " + spokenText(String(next)) + ".";
    setStatus("Хурд " + next + "×");
    pauseForPrompt(function () {
      return prompt(text);
    });
  }

  function cycleSpeed(): void {
    const i = SPEEDS.indexOf(speedRef.current);
    changeSpeed(i >= SPEEDS.length - 1 ? -1 : 1);
  }

  function back(): void {
    shutdown();
    router.push("/");
  }

  function helpKey(): PhraseKey {
    return modeRef.current === "sr" ? "read_help_sr" : canListen() ? "read_help" : "read_help_menu";
  }

  function help(): void {
    pauseForPrompt(function () {
      return say(helpKey());
    });
  }

  function act(c: ReaderCommand): void {
    const s = session.current;
    if (c === "back") {
      back();
    } else if (c === "help") {
      help();
    } else if (c === "where") {
      where();
    } else if (c === "newPage") {
      newPage();
    } else if (c === "faster" || c === "slower") {
      changeSpeed(c === "faster" ? 1 : -1);
    } else if (!s) {
      if (phaseRef.current === "aim") {
        capture(); // "унш" while aiming: take the photo
      }
    } else if (c === "pause") {
      if (!s.paused) {
        togglePause();
      }
    } else if (c === "resume") {
      if (s.paused) {
        togglePause();
      } else if (phaseRef.current === "pageEnd") {
        newPage();
      }
    } else if (c === "repeat") {
      s.paused = false;
      setPaused(false);
      setPhase("reading");
      readFrom(s, Math.min(s.index, s.sentences.length - 1));
    } else if (c === "previous") {
      step(-1);
    } else if (c === "next") {
      step(1);
    } else if (c === "fromStart") {
      s.paused = false;
      setPaused(false);
      setPhase("reading");
      readFrom(s, 0);
    }
  }

  function openMenu(): void {
    const s = session.current;
    const wasPlaying = Boolean(s && !s.paused && phaseRef.current === "reading");
    if (wasPlaying) {
      togglePause();
    }
    aimRun.current++; // aiming hints would talk over the menu
    const items: MenuEntry[] =
      phaseRef.current === "aim" || !s
        ? [
            { label: "read_btn_help", command: "help" },
            { label: "read_btn_back", command: "back" },
            { label: "read_btn_close_menu", command: "close" },
          ]
        : [
            { label: "read_btn_page", command: "newPage" },
            { label: "read_btn_from_start", command: "fromStart" },
            { label: "read_btn_faster", command: "faster" },
            { label: "read_btn_slower", command: "slower" },
            { label: "read_btn_help", command: "help" },
            { label: "read_btn_back", command: "back" },
            { label: "read_btn_close_menu", command: "close" },
          ];
    menu.current = { items, at: -1, wasPlaying };
    setStatus(phrase("read_menu_open"));
    // Every option once, so the rider knows what's there before swiping.
    prompt(
      [phrase("read_menu_open")]
        .concat(
          items.map(function (item) {
            return phrase(item.label) + ".";
          }),
        )
        .join(" "),
    );
  }

  function menuStep(direction: 1 | -1): void {
    const m = menu.current;
    if (!m) {
      return;
    }
    m.at = Math.max(0, Math.min(m.items.length - 1, m.at + direction));
    sayMenuItem();
  }

  function sayMenuItem(): void {
    const m = menu.current;
    if (!m) {
      return;
    }
    if (m.at < 0) {
      say("read_menu_open");
      return;
    }
    say(m.items[m.at].label);
  }

  // The reading (or aiming) goes on as it was before the menu opened.
  function carryOn(m: Menu, said: Promise<void>): void {
    const s = session.current;
    if (m.wasPlaying && s && s.paused) {
      togglePause();
    }
    if (phaseRef.current === "aim") {
      aim(false, said);
    }
  }

  function closeMenu(): void {
    const m = menu.current;
    menu.current = null;
    if (m) {
      carryOn(m, say("read_menu_closed"));
    }
  }

  function chooseMenuItem(): void {
    const m = menu.current;
    if (!m || m.at < 0) {
      sayMenuItem(); // nothing chosen yet: how to choose
      return;
    }
    const c = m.items[m.at].command;
    menu.current = null;
    if (c === "close") {
      carryOn(m, say("read_menu_closed"));
    } else if (c === "back" || c === "newPage") {
      act(c);
    } else if (phaseRef.current === "aim") {
      carryOn(m, say(helpKey())); // only help is offered while aiming
    } else {
      carryOn(m, Promise.resolve());
      act(c);
    }
  }

  // Press and hold: the reading pauses, the rider says a command, then it goes on (or does it).
  async function holdStart(): Promise<void> {
    if (menu.current) {
      closeMenu();
      return;
    }
    if (!canListen()) {
      openMenu();
      return;
    }
    if (talking.current) {
      return;
    }
    const s = session.current;
    const wasPlaying = Boolean(s && !s.paused && s.playing);
    if (s && s.playing && wasPlaying) {
      s.playing.pause();
    }
    const rec = listenToRider();
    talking.current = rec;
    beep();
    setStatus(phrase("listening"));
    const heard = await rec.done;
    talking.current = null;
    const c = heard.text ? readerCommand(heard.text) : null;
    setStatus(heard.text ? "“" + heard.text + "”" : "");
    if (c) {
      if (s && wasPlaying && s.playing && c !== "pause") {
        s.playing.resume();
      }
      act(c);
    } else {
      await say(heard.text ? "read_not_understood" : "not_heard");
      if (s && wasPlaying && session.current === s && s.playing) {
        s.playing.resume();
      }
    }
  }

  function holdEnd(): void {
    if (talking.current) {
      talking.current.stop();
    }
  }

  function doubleTap(): void {
    unlockPlayer();
    if (menu.current) {
      chooseMenuItem();
      return;
    }
    const p = phaseRef.current;
    if (p === "aim") {
      capture();
    } else if (p === "reading") {
      togglePause();
    } else {
      newPage();
    }
  }

  function swipe(direction: 1 | -1): void {
    if (menu.current) {
      menuStep(direction);
    } else if (phaseRef.current === "reading" || phaseRef.current === "pageEnd") {
      step(direction);
    }
  }

  function tap(): void {
    if (menu.current) {
      sayMenuItem();
    } else {
      where();
    }
  }

  // ---- screen ----
  const reading = phase === "reading" || phase === "pageEnd";
  const title =
    phase === "start" ? "Бичиг уншигч" : phase === "aim" ? "Бичиг рүү чиглүүлнэ үү" : phase === "reading" ? (paused ? "Түр зогссон" : "Уншиж байна") : "Хуудас дууслаа";
  // Seen, not announced: a screen reader would read every percent.
  const progress =
    voiceLoad !== null ? (
      <p className="reader-progress" aria-hidden="true">
        Монгол хоолой: {voiceLoad}%
      </p>
    ) : null;

  const text = reading ? (
    <div className="reader-text" aria-hidden="true">
      {sentences.length === 0 && <p className="reader-wait">…</p>}
      <p>
        {sentences.map(function (item, i) {
          const cls = (i === at ? "reader-current " : "") + (item.unsure ? "reader-unsure" : "");
          return (
            <span key={i} ref={i === at ? currentRef : undefined} className={cls || undefined}>
              {item.unclear ? "[…] " : ""}
              {item.text}{" "}
            </span>
          );
        })}
      </p>
    </div>
  ) : null;

  if (phase === "start") {
    // Same two halves as the bus app. The screen-reader choice is first, so the first swipe lands there.
    return (
      <main className="flow start-screen">
        <button
          type="button"
          className="start-half"
          onClick={function () {
            begin("sr");
          }}
        >
          Дэлгэц уншигчтай (VoiceOver, TalkBack)
        </button>
        <button
          type="button"
          className="start-half"
          onClick={function () {
            begin("voice");
          }}
        >
          Дэлгэц уншигчгүй
        </button>
      </main>
    );
  }

  const backItem: MenuItem = { id: "back", label: phrase("read_btn_back"), onActivate: back };
  const againItem: MenuItem = { id: "again", label: phrase("menu_hear_again"), onActivate: hearAgain };
  let main: MenuItem[] = [];
  if (phase === "aim") {
    main = [{ id: "capture", label: phrase("read_btn_capture"), onActivate: capture }];
  } else if (phase === "pageEnd") {
    main = [
      { id: "page", label: phrase("read_btn_page"), onActivate: newPage },
      { id: "from", label: phrase("read_btn_from_start"), onActivate: function () { act("fromStart"); } },
    ];
  } else {
    main = [
      { id: "pause", label: phrase(paused ? "read_btn_resume" : "read_btn_pause"), onActivate: togglePause },
      { id: "prev", label: phrase("read_btn_prev"), onActivate: function () { step(-1); } },
      { id: "next", label: phrase("read_btn_next"), onActivate: function () { step(1); } },
      { id: "speed", label: phrase("read_btn_speed") + " " + speed + "×", onActivate: cycleSpeed },
    ];
  }
  const bar = [backItem, againItem];
  // The Mongolian voice is reading the sentence. A live region would say it again, in the phone's voice.
  const live = phase === "reading" && !appReading;
  const view = (
    <>
      <video
        ref={videoNode}
        playsInline
        muted
        aria-hidden="true"
        className={phase === "aim" ? "camera-video reader-video" : "reader-video-hidden"}
      />
      {progress}
      {text}
    </>
  );

  return (
    <main className={"flow reader" + (phase === "aim" ? " reader-aim" : "")}>
      <h1 ref={headingRef} tabIndex={-1} className="title">
        {title}
      </h1>
      <p className="status" role={live ? "status" : undefined} aria-live={live ? "polite" : undefined}>
        {status}
      </p>
      {mode === "voice" ? (
        <ReaderPad onTouch={unlockPlayer} onDoubleTap={doubleTap} onSwipe={swipe} onTap={tap} onHoldStart={holdStart} onHoldEnd={holdEnd}>
          {view}
        </ReaderPad>
      ) : (
        view
      )}
      <div className="actions">
        <button
          type="button"
          className="action reader-primary"
          onClick={function () {
            unlockPlayer();
            main[0].onActivate();
          }}
        >
          {main[0].label}
        </button>
        {main.length > 1 && (
          <div className="reader-row">
            {main.slice(1).map(function (item) {
              return (
                <button
                  key={item.id}
                  type="button"
                  className="action"
                  onClick={function () {
                    unlockPlayer();
                    item.onActivate();
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="reader-bar">
        {bar.map(function (item) {
          return (
            <button
              key={item.id}
              type="button"
              className="action"
              onClick={function () {
                unlockPlayer();
                item.onActivate();
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </main>
  );
}
