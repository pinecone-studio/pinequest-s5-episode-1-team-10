"use client";

// Rider journey: start -> (first time) family number for SOS -> where am I (GPS, or say / type it)
// -> say or type the destination -> one suggested bus -> camera -> "this is your bus". Every screen
// is spoken in Mongolian: its message, then its options (VoiceMenu), so a blind rider always knows
// what they can do. Anything the rider can say can also be typed (iPhone has no Mongolian speech
// recognition), and a phone number is always read back digit by digit to confirm.
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AskResponse, BoardStop, PlanResponse, PlanStop, VoiceLocateResponse } from "../../shared/contract";
import { askByText, askByVoice, locateBySpeech, locateByText, nearestStop, requestPlan, requestVoicePlan, serverCaps, wakeServer, type ServerCaps } from "../lib/api";
import { canListenInMongolian, listenInBrowser, type Heard } from "../lib/listen";
import { GPS_OK_M, locate, type Position } from "../lib/location";
import { beep, record, type Recording } from "../lib/record";
import { primeBeacon } from "../lib/beacon";
import { familyNumber, openLink, saveFamilyNumber, smsUrl, sosMessage, telUrl } from "../lib/family";
import { groupDigits, phoneDigits } from "../lib/phoneWords";
import { savedMode, saveMode, type Mode } from "../lib/mode";
import { routeLabel } from "../lib/route";
import { loadDetector } from "../lib/detector";
import { loadDoorDetector } from "../lib/doorDetector";
import { loadOcr } from "../lib/ocr";
import type { DoorGuide } from "../lib/door";
import { phrase, prefetch, rememberClips, say, stopSpeaking, unlockAudio, vibrate, type PhraseKey } from "../lib/speech";
import { onSpeedReport, showSpeed, speedCancel, speedMark, speedStart } from "../lib/speed";
import BusCamera, { doorSpeech } from "./BusCamera";
import RideGuide, { leftSpeech, type RideInfo } from "./RideGuide";
import Tutorial, { tutorialNeeded } from "./Tutorial";
import Settings from "./Settings";
import SrScreen from "./SrScreen";
import TypeIn from "./TypeIn";
import VoiceMenu, { type MenuItem } from "./VoiceMenu";

type Step =
  | "start"
  | "learn" // first-use lesson: headphones, wearing the phone, gestures, ear check
  | "locating"
  | "where"
  | "whereListening"
  | "ask"
  | "listening"
  | "working"
  | "planned"
  | "camera" // find the bus, then guide to its door
  | "ride" // on the bus, until the rider's stop
  | "arrived"
  | "number" // family phone number for SOS: say it or type it?
  | "numberListening"
  | "numberConfirm" // read back digit by digit: correct?
  | "typing" // typing instead of speaking (see typeFor)
  | "settings"; // helper / screen-reader settings: mode, family number, typed destination

type TypeFor = "number" | "dest" | "where";
const TYPE_PROMPT: Record<TypeFor, PhraseKey> = { number: "number_type_now", dest: "dest_type_now", where: "where_type_now" };
const TYPE_LABEL: Record<TypeFor, string> = { number: "Гэр бүлийн утасны дугаар", dest: "Очих газар", where: "Ойролцоох зогсоол" };
const PHONE_DIGITS = 8; // Mongolian mobile numbers

// ?ride=sim, or a demo photo instead of the camera: the bus drives the real stops at demo speed.
function simulatedRide(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.get("ride") === "sim" || q.has("image") || q.has("video");
}

// One bus of the trip: the first, or the second after a transfer (дамжин суух).
interface Leg {
  route: string;
  board: BoardStop;
  alight: PlanStop;
  foundSpeech: string;
}
function legOf(plan: PlanResponse, leg: number): Leg {
  const t = plan.transfer;
  return leg === 1 && t
    ? { route: t.route, board: t.board_stop, alight: t.alight_stop, foundSpeech: t.found_speech }
    : { route: plan.route, board: plan.board_stop, alight: plan.alight_stop, foundSpeech: plan.found_speech };
}

// ?lat=47.91&lon=106.92 overrides GPS, for testing away from the stop.
function testPosition(): Position | null {
  const q = new URLSearchParams(window.location.search);
  const lat = parseFloat(q.get("lat") ?? "");
  const lon = parseFloat(q.get("lon") ?? "");
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, accuracy: 0 } : null;
}

export default function RiderFlow() {
  const [step, setStep] = useState<Step>("start");
  const [mode, setMode] = useState<Mode>("voice");
  const [serverOcr, setServerOcr] = useState(true); // false on free hosting: the phone reads the signs
  const modeRef = useRef<Mode>("voice"); // for callbacks
  // "Swipe right / double tap" only make sense without a screen reader.
  function welcome(): PhraseKey {
    return modeRef.current === "sr" ? "welcome_sr" : "welcome";
  }
  const [message, setMessage] = useState("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [leg, setLeg] = useState(0); // 0: first bus, 1: second bus after the transfer
  const planRef = useRef<PlanResponse | null>(null); // for callbacks
  const legRef = useRef(0);
  const position = useRef<Position | null>(null);
  const fromGps = useRef(false); // GPS positions are refreshed on each request; a said place is kept
  const recording = useRef<Recording | null>(null);
  const caps = useRef<ServerCaps>({ stt: true, ocr: true });
  const browserListening = useRef<{ stop: () => void } | null>(null);
  const [found, setFound] = useState(false); // the camera confirmed the rider's bus: now guiding to its door
  const doorGuide = useRef<DoorGuide | null>(null);
  const rideInfo = useRef<RideInfo | null>(null);
  // SOS menu on top of whatever screen (camera, ride keep running): text or call the family.
  const [sos, setSos] = useState<{ mode: "sms" | "call"; body: string } | null>(null);
  const [typeFor, setTypeFor] = useState<TypeFor>("dest");
  const typeField = useRef<HTMLInputElement>(null);
  const [pendingNumber, setPendingNumber] = useState(""); // said or typed, waiting for "correct?"
  const numberNext = useRef<"find" | "ask">("find"); // where the number setup goes when done
  const numberLater = useRef(false); // "Дараа нь": not asked again until the app is opened again
  const voiceBroken = useRef(false); // this browser can't recognise Mongolian: typing from now on

  // Show and speak: keys are pre-made clips (instant), plain strings are made live.
  function announce(parts: (PhraseKey | { text: string })[]): Promise<void> {
    const texts = parts.map(function (item) {
      return typeof item === "string" ? phrase(item) : item.text;
    });
    setMessage(texts.join(" "));
    return say(texts);
  }

  function setPlaceName(name: string): void {
    prefetch([name]); // so "Миний байршил" can say it at once
  }

  function showPlan(found: PlanResponse): void {
    setPlan(found);
    planRef.current = found;
    legRef.current = 0;
    setLeg(0);
    setStep("planned");
    setMessage(found.speech.join(" "));
    // The first sentence ("34-р автобусанд суугаарай.") is pre-made, so it plays at once.
    say(found.speech.concat(phrase("open_camera")));
    // Load + warm both models while the route is read out, so the camera detects from its first frame.
    loadDetector()
      .then(async function (provider) {
        if (!caps.current.ocr) {
          await loadOcr(); // free hosting: the phone reads the signs (before the 40 MB door model downloads)
        }
        // Without WebGPU the door model would queue in front of bus detection: it loads after the "yes".
        return provider === "webgpu" ? loadDoorDetector() : undefined;
      })
      .catch(function () {
        // the camera step loads (and reports) it again
      });
  }

  // GPS if it's precise enough; otherwise the rider is asked to say where they are.
  async function findMe(intro: PhraseKey[]): Promise<void> {
    setStep("locating");
    const gps = testPosition() ? Promise.resolve(testPosition()) : locate();
    await announce(intro);
    const pos = await gps;
    if (!pos || pos.accuracy > GPS_OK_M) {
      setStep("where");
      announce(["ask_location"]);
      return;
    }
    position.current = pos;
    fromGps.current = true;
    const near = await nearestStop(pos.lat, pos.lon);
    setPlaceName(near ? near.name : "GPS ±" + Math.round(pos.accuracy) + " м");
    setStep("ask");
    announce(["location_ok", welcome()]);
  }

  function begin(chosen: Mode): void {
    modeRef.current = chosen;
    setMode(chosen);
    saveMode(chosen);
    unlockAudio(); // inside the first touch, or iPhones stay silent
    primeBeacon(); // the lesson's ear check plays the door beacon
    serverCaps().then(function (c) {
      caps.current = c;
      setServerOcr(c.ocr);
      if (!c.stt && !canListenInMongolian()) {
        voiceBroken.current = true; // iPhone: typing whenever the rider chooses to say something
      }
    });
    if (tutorialNeeded()) {
      setStep("learn");
    } else if (needsNumber()) {
      startNumberSetup("find");
    } else {
      findMe(["locating"]);
    }
  }

  // SOS needs the family number first: asked before anything else until it's saved (or put off).
  function needsNumber(): boolean {
    return !familyNumber() && !numberLater.current;
  }

  // After the lesson: find the rider (first time) or go back to choosing a destination (replay from Help).
  const onLearned = useCallback(function () {
    if (needsNumber()) {
      startNumberSetup(position.current ? "ask" : "find");
    } else if (position.current) {
      setStep("ask");
      announce([welcome()]);
    } else {
      findMe(["locating"]);
    }
    // announce/findMe only use refs and state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function replayTutorial(): void {
    stopSpeaking();
    primeBeacon();
    setStep("learn");
  }

  // Free hosting has no Whisper: the browser recognises the speech, and the text goes to the server.
  async function hearInBrowser(listeningStep: Step): Promise<Heard> {
    stopSpeaking();
    setStep(listeningStep);
    setMessage(phrase("menu_stop_listening"));
    await beep();
    const rec = listenInBrowser();
    browserListening.current = rec;
    const heard = await rec.done;
    browserListening.current = null;
    return heard;
  }

  // Nothing came back from the browser's recognition: say why, and show the browser's reason for a
  // helper. A browser that can't recognise Mongolian (iPhone) goes straight to typing, now and later.
  function notHeard(heard: Heard, typeInstead: TypeFor): void {
    if (heard.error === "unsupported") {
      voiceBroken.current = true;
      openTyping(typeInstead, "voice_unsupported_type", heard.code);
      return;
    }
    const key = heard.error === "no-mic" ? "mic_failed" : heard.error === "network" ? "voice_network" : "not_heard";
    say([phrase(key)]);
    setMessage(phrase(key) + (heard.error === "not-heard" ? "" : " (" + heard.code + ")"));
  }

  // Beep, record until the rider stops talking (or double taps). null = nothing said; the caller
  // says "not heard" unless the microphone itself is blocked, which is said here.
  async function hear(listeningStep: Step, backStep: Step): Promise<Blob | null> {
    stopSpeaking();
    setStep(listeningStep);
    setMessage(phrase("menu_stop_listening"));
    await beep();
    const rec = record();
    recording.current = rec;
    const wav = await rec.done;
    recording.current = null;
    if (!wav && rec.noMic()) {
      setStep(backStep);
      announce(["mic_failed"]);
      throw new Error("no microphone");
    }
    return wav;
  }

  function applyPlace(result: VoiceLocateResponse | null): void {
    if (!result) {
      setStep("where");
      announce(["server_down"]);
    } else if (result.stop) {
      position.current = { lat: result.stop.lat, lon: result.stop.lon, accuracy: 0 };
      fromGps.current = false;
      setPlaceName(result.stop.name);
      setStep("ask");
      announce(["location_ok", welcome()]);
    } else {
      setStep("where");
      setMessage((result.heard ? "“" + result.heard + "” — " : "") + result.message);
      say([result.message ?? phrase("not_heard")]);
    }
  }

  async function sayWhereIAm(): Promise<void> {
    if (voiceBroken.current && !caps.current.stt) {
      openTyping("where", "voice_unsupported_type");
      return;
    }
    if (!caps.current.stt) {
      const heard = await hearInBrowser("whereListening");
      const text = heard.text;
      if (!text) {
        setStep("where");
        notHeard(heard, "where");
        return;
      }
      setStep("working");
      applyPlace(await locateByText(text));
      return;
    }
    const wav = await hear("whereListening", "where").catch(function () {
      return undefined;
    });
    if (wav === undefined) {
      return; // microphone blocked, already said
    }
    if (!wav) {
      setStep("where");
      announce(["not_heard"]);
      return;
    }
    setStep("working");
    applyPlace(await locateBySpeech(wav));
  }

  // Latest position: GPS is refreshed (the rider may have walked), a said place is kept.
  async function currentPosition(): Promise<Position | null> {
    if (fromGps.current && !testPosition()) {
      const pos = await locate();
      if (pos && pos.accuracy <= GPS_OK_M) {
        position.current = pos;
      }
    }
    return position.current;
  }

  function planFailed(heardText: string, message: string | null): void {
    setStep("ask");
    setMessage((heardText ? "“" + heardText + "” — " : "") + (message ?? phrase("server_down")));
    say([message ?? phrase("server_down")]);
  }

  async function planTrip(text: string): Promise<void> {
    setStep("working");
    const pos = await currentPosition();
    if (!pos) {
      setStep("where");
      announce(["ask_location"]);
      return;
    }
    announce(["searching"]);
    const result = await requestPlan(text, pos.lat, pos.lon);
    if (result.ok) {
      showPlan(result.plan);
    } else {
      planFailed(text, result.message || null);
    }
  }

  async function sayDestination(): Promise<void> {
    if (voiceBroken.current && !caps.current.stt) {
      openTyping("dest", "voice_unsupported_type");
      return;
    }
    if (!caps.current.stt) {
      const heard = await hearInBrowser("listening");
      const text = heard.text;
      if (!text) {
        setStep("ask");
        notHeard(heard, "dest");
        return;
      }
      planTrip(text);
      return;
    }
    const positionNow = currentPosition(); // GPS refresh runs while the rider talks
    const wav = await hear("listening", "ask").catch(function () {
      return undefined;
    });
    if (wav === undefined) {
      return; // microphone blocked, already said
    }
    if (!wav) {
      setStep("ask");
      announce(["not_heard"]);
      return;
    }
    setStep("working");
    const pos = await positionNow;
    if (!pos) {
      setStep("where");
      announce(["ask_location"]);
      return;
    }
    const result = await requestVoicePlan(wav, pos.lat, pos.lon);
    if (result && result.plan) {
      showPlan(result.plan);
    } else {
      planFailed(result ? result.heard : "", result ? result.message : null);
    }
  }

  // ---- Family number for SOS: say it or type it, then hear it back digit by digit and confirm. ----
  function startNumberSetup(next: "find" | "ask"): void {
    numberNext.current = next;
    setStep("number");
    announce(["number_setup"]);
  }

  async function sayNumber(): Promise<void> {
    if (voiceBroken.current && !caps.current.stt) {
      openTyping("number", "voice_unsupported_type");
      return;
    }
    setStep("numberListening");
    setMessage(phrase("number_say_now"));
    await say([phrase("number_say_now")]);
    let text = "";
    if (!caps.current.stt) {
      const heard = await hearInBrowser("numberListening");
      if (!heard.text) {
        setStep("number");
        notHeard(heard, "number");
        return;
      }
      text = heard.text;
    } else {
      const wav = await hear("numberListening", "number").catch(function () {
        return undefined;
      });
      if (wav === undefined) {
        return; // microphone blocked, already said
      }
      // The server's speech recognition, via the "where am I" endpoint: only its "heard" text is used.
      const result = wav ? await locateBySpeech(wav) : null;
      text = result ? result.heard : "";
    }
    gotNumber(text);
  }

  function gotNumber(text: string): void {
    const digits = phoneDigits(text);
    if (digits.length < PHONE_DIGITS) {
      setStep("number");
      setMessage((text ? "“" + text + "” — " : "") + phrase("number_short"));
      say([phrase("number_short")]);
      return;
    }
    setPendingNumber(digits);
    setStep("numberConfirm");
    setMessage(phrase("number_is") + " " + groupDigits(digits) + ". " + phrase("number_check"));
    const spoken = digits.split("").map(function (item) {
      return phrase(("digit_" + item) as PhraseKey);
    });
    say([phrase("number_is")].concat(spoken, phrase("number_check")));
  }

  async function numberCorrect(): Promise<void> {
    saveFamilyNumber(pendingNumber);
    setPendingNumber("");
    await numberDone("number_saved");
  }
  function numberAgain(): void {
    setPendingNumber("");
    startNumberSetup(numberNext.current);
  }
  async function numberPutOff(): Promise<void> {
    numberLater.current = true;
    await numberDone("number_later");
  }
  async function numberDone(key: PhraseKey): Promise<void> {
    if (numberNext.current === "find") {
      setStep("locating");
      await announce([key]);
      findMe(["locating"]);
    } else {
      setStep("ask");
      announce([key, welcome()]);
    }
  }

  // ---- Typing instead of speaking. Opened inside the rider's tap where possible, so the field can
  // take focus at once (iPhone shows its keyboard only for a focus made during a touch). ----
  function openTyping(kind: TypeFor, intro?: PhraseKey, code?: string): void {
    const parts = (intro ? [phrase(intro)] : []).concat(phrase(TYPE_PROMPT[kind]));
    say(parts); // first, so the screen's options are read after it, not cut off by it
    flushSync(function () {
      setTypeFor(kind);
      setStep("typing");
      setMessage(parts.join(" ") + (code ? " (" + code + ")" : ""));
    });
    if (typeField.current) {
      typeField.current.focus();
    }
  }

  function typed(text: string): void {
    if (!text) {
      announce(["nothing_typed"]);
      return;
    }
    if (typeFor === "number") {
      gotNumber(text);
    } else if (typeFor === "dest") {
      planTrip(text);
    } else {
      setStep("working");
      locateByText(text).then(applyPlace);
    }
  }
  function typedFromMenu(): void {
    typed(typeField.current ? typeField.current.value.trim() : "");
  }
  function typingBack(): void {
    stopSpeaking();
    if (typeFor === "number") {
      startNumberSetup(numberNext.current);
    } else {
      setStep(typeFor === "dest" ? "ask" : "where");
      announce([typeFor === "dest" ? welcome() : "ask_location"]);
    }
  }

  const onFound = useCallback(function () {
    setFound(true);
    const p = planRef.current;
    if (p) {
      setMessage(legOf(p, legRef.current).foundSpeech + " " + phrase("door_intro"));
    }
  }, []);
  const onArrived = useCallback(function () {
    const p = planRef.current;
    if (p && p.transfer && legRef.current === 0) {
      // Off bus 1 at the transfer stop: now the second bus (its speech says how far to walk, if at all).
      legRef.current = 1;
      setLeg(1);
      setFound(false);
      setStep("planned");
      const texts = [phrase("transfer_arrived")].concat(p.transfer.speech, phrase("open_camera"));
      setMessage(texts.join(" "));
      say(texts);
      return;
    }
    setStep("arrived");
    setMessage(phrase("arrived"));
    say([phrase("arrived")]);
  }, []);
  const onCameraError = useCallback(function () {
    setStep("planned");
  }, []);

  function label(id: string, key: PhraseKey): { id: string; label: string } {
    return { id, label: phrase(key) };
  }
  function sayHelp(): void {
    announce(["help"]);
  }
  function stopRecording(): void {
    if (recording.current) {
      recording.current.stop();
    }
    if (browserListening.current) {
      browserListening.current.stop();
    }
  }
  function retryGps(): void {
    findMe(["locating"]);
  }
  function openCamera(): void {
    stopSpeaking();
    primeBeacon(); // inside the double tap, or iPhones won't play the door beacon
    setFound(false);
    setStep("camera");
    setMessage(phrase("camera_on"));
  }
  function whereIsDoor(): void {
    const g = doorGuide.current;
    say(g ? doorSpeech(g) : [phrase("door_lost")]);
  }
  function boarded(): void {
    stopSpeaking();
    setStep("ride");
    setMessage(phrase("ride_start"));
  }
  function stopsLeft(): void {
    const r = rideInfo.current;
    if (r) {
      say([leftSpeech(r.left)].concat(r.next).filter(Boolean));
    }
  }
  function gotOff(): void {
    onArrived();
  }
  function backToPlan(): void {
    stopSpeaking();
    setStep("planned");
  }
  function startOver(): void {
    setPlan(null);
    planRef.current = null;
    legRef.current = 0;
    setLeg(0);
    setStep("ask");
    announce([welcome()]);
  }

  // Voice assistant: press and hold anywhere, on any screen, and talk; release when done. It records in
  // place, so the camera or ride keeps running; the server answers from our bus data only and may name
  // an action ("plan", "open_camera", "door"...), done here like the menu option would.
  const talk = useRef<{ stop: () => void } | null>(null);
  const [speedLine, setSpeedLine] = useState("");
  useEffect(function () {
    if (showSpeed()) {
      onSpeedReport(setSpeedLine);
    }
  }, []);
  function startTalk(): void {
    if (talk.current) {
      return;
    }
    stopSpeaking();
    const pos = position.current;
    if (!pos) {
      announce(["ask_location"]);
      return;
    }
    speedStart();
    wakeServer(); // a sleeping free server starts up while the rider is still talking
    const legNow = plan ? legOf(plan, legRef.current) : null;
    const context = { step, route: legNow ? legNow.route : "", alight: legNow ? legNow.alight.name : "" };
    setMessage(phrase("listening"));
    let released = false; // the finger may lift before the microphone is on
    const session = {
      stop: function () {
        released = true;
      },
    };
    talk.current = session;
    // "Түр хүлээнэ үү" only if the answer is slow; a fast answer would just cut it off mid-word.
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    function sayWaitIfSlow(): void {
      waitTimer = setTimeout(function () {
        say([phrase("wait")]);
      }, 700);
    }
    (async function () {
      let result: AskResponse | null;
      if (!caps.current.stt) {
        // The microphone opens while the beep plays, so the rider can talk right after it.
        const rec = listenInBrowser();
        session.stop = rec.stop;
        if (released) {
          rec.stop();
        }
        beep();
        const heard = await rec.done;
        const text = heard.text;
        talk.current = null;
        if (!text) {
          speedCancel();
          if (heard.error === "unsupported") {
            // Asking by voice isn't possible in this browser; every menu (and typing) still is.
            voiceBroken.current = true;
            announce(["voice_unsupported"]);
          } else {
            notHeard(heard, "dest");
          }
          return;
        }
        sayWaitIfSlow();
        result = await askByText(text, pos.lat, pos.lon, context);
      } else {
        await beep();
        const rec = record();
        recording.current = rec;
        session.stop = rec.stop;
        if (released) {
          rec.stop();
        }
        const wav = await rec.done;
        recording.current = null;
        talk.current = null;
        if (!wav) {
          speedCancel();
          announce([rec.noMic() ? "mic_failed" : "not_heard"]);
          return;
        }
        speedMark("recorded");
        sayWaitIfSlow(); // a new sentence's voice is made live (~8 s); fixed ones play at once
        result = await askByVoice(wav, pos.lat, pos.lon, context);
      }
      clearTimeout(waitTimer);
      if (!result) {
        speedCancel();
        announce(["server_down"]);
        return;
      }
      speedMark("answer");
      rememberClips(result.speech, result.clips);
      setMessage(result.heard && result.answer ? "“" + result.heard + "” — " + result.answer : result.answer || "“" + result.heard + "”");
      doAction(result);
    })();
  }
  function endTalk(): void {
    if (talk.current) {
      talk.current.stop();
    }
  }

  function doAction(result: AskResponse): void {
    const a = result.action;
    if (a === "plan" && result.plan) {
      showPlan(result.plan);
      say(result.speech.concat(phrase("open_camera")));
    } else if (a === "open_camera") {
      openCamera();
    } else if (a === "door") {
      whereIsDoor();
    } else if (a === "stops_left") {
      stopsLeft();
    } else if (a === "boarded") {
      boarded();
    } else if (a === "got_off") {
      gotOff();
    } else if (a === "start_over") {
      startOver();
    } else if (a === "sos" || a === "call_family") {
      startSos(a === "sos" ? "sms" : "call", result);
    } else if (a === "tutorial") {
      replayTutorial();
    } else {
      say(result.speech);
    }
  }

  // The rider asked for help: ready the message (or call) and wait for a double tap, because phones
  // only open the SMS app / dialer from a tap, and a misheard word must never send an SOS by itself.
  function startSos(mode: "sms" | "call", result: AskResponse): void {
    const where = result.speech.slice(1).join(" "); // "Та Төв номын сан зогсоолоос 20 метр зайд байна."
    if (!familyNumber()) {
      setMessage(phrase("sos_no_contact_setup") + " " + where);
      say([phrase("sos_no_contact_setup")].concat(result.speech.slice(1)));
      return;
    }
    const pos = position.current;
    const body = pos ? sosMessage(pos.lat, pos.lon, where) : sosMessage(0, 0, where).split(" Байршил:")[0];
    vibrate([500, 200, 500, 200, 500]);
    setSos({ mode, body });
    setMessage(body);
    say([phrase(mode === "sms" ? "sos_confirm" : "sos_call_confirm")]);
  }
  function sosSend(): void {
    if (sos) {
      openLink(smsUrl(familyNumber(), sos.body));
      setSos(null);
      say([phrase("sos_opened")]);
    }
  }
  function sosCall(): void {
    setSos(null);
    openLink(telUrl(familyNumber()));
  }
  function sosCancel(): void {
    setSos(null);
    setMessage("");
    say([phrase("sos_cancelled")]);
  }

  // SOS without speaking (screen-reader button): same as saying "тусламж хэрэгтэй".
  async function sosButton(): Promise<void> {
    stopSpeaking();
    const pos = position.current;
    const r = pos ? await askByText("Тусламж хэрэгтэй", pos.lat, pos.lon, { step, route: "", alight: "" }) : null;
    startSos("sms", r ?? { heard: "", answer: "", speech: [""], action: "sos", plan: null });
  }
  function openSettings(): void {
    stopSpeaking();
    setStep("settings");
  }
  function chooseMode(m: Mode): void {
    modeRef.current = m;
    setMode(m);
    saveMode(m);
  }
  function typedDestination(text: string): void {
    planTrip(text);
  }
  function typeDestination(): void {
    openTyping("dest");
  }
  function typeWhere(): void {
    openTyping("where");
  }
  function typeNumber(): void {
    openTyping("number");
  }
  function changeNumber(): void {
    stopSpeaking();
    startNumberSetup("ask");
  }

  // Each screen: a heading saying where you are, and at most three things to do. Everything else is
  // by voice (press and hold, or "Дуугаар асуух" with a screen reader).
  let title = "";
  let actions: MenuItem[] = [];
  let primary: number | undefined = 0;
  const cur = plan ? legOf(plan, leg) : null; // the bus the rider is taking now
  if (step === "locating" || step === "working") {
    title = step === "locating" ? "Байршил тогтоож байна" : "Түр хүлээнэ үү";
  } else if (step === "where") {
    title = "Та хаана байна?";
    actions = [
      { ...label("say-where", "menu_say_where"), onActivate: sayWhereIAm },
      { ...label("type-where", "menu_type_where"), onActivate: typeWhere },
      { ...label("gps", "menu_retry_gps"), onActivate: retryGps },
    ];
  } else if (step === "ask") {
    title = "Хаашаа явах вэ?";
    actions = [
      { ...label("say-dest", "menu_say_destination"), onActivate: sayDestination },
      { ...label("type-dest", "menu_type_destination"), onActivate: typeDestination },
      { ...label("sos-number", "menu_sos_number"), onActivate: changeNumber },
    ];
  } else if (step === "number") {
    title = "Яаралтай тусламжийн дугаар";
    actions = [
      { ...label("number-say", "menu_number_say"), onActivate: sayNumber },
      { ...label("number-type", "menu_number_type"), onActivate: typeNumber },
      { ...label("number-later", "menu_later"), onActivate: numberPutOff },
    ];
  } else if (step === "numberConfirm") {
    title = groupDigits(pendingNumber) + " — зөв үү?";
    actions = [
      { ...label("number-yes", "menu_yes_correct"), onActivate: numberCorrect },
      { ...label("number-no", "menu_no_again"), onActivate: numberAgain },
    ];
  } else if (step === "typing") {
    title = TYPE_LABEL[typeFor];
    // Screen-reader mode: the form's own "Болсон" button; app-reads mode: also a menu option.
    actions = mode === "sr" ? [] : [{ ...label("typed", "menu_done"), onActivate: typedFromMenu }];
    actions = actions.concat({ ...label("type-back", "menu_back"), onActivate: typingBack });
  } else if (step === "numberListening") {
    title = mode === "sr" ? "Яаралтай тусламжийн дугаар" : "Сонсож байна";
    actions = [{ ...label(mode === "sr" ? "number-say" : "stop", "menu_stop_listening"), onActivate: stopRecording }];
  } else if (step === "listening" || step === "whereListening") {
    // Screen-reader mode keeps the heading and puts "stop" on the very button just pressed (same key),
    // so focus doesn't move and the screen reader stays quiet: the microphone is on.
    const asked = step === "listening" ? "say-dest" : "say-where";
    title = mode === "sr" ? (step === "listening" ? "Хаашаа явах вэ?" : "Та хаана байна?") : "Сонсож байна";
    actions = [{ ...label(mode === "sr" ? asked : "stop", "menu_stop_listening"), onActivate: stopRecording }];
  } else if (step === "planned" && cur) {
    title = routeLabel(cur.route) + " автобус";
    actions = [{ ...label("camera", "menu_open_camera"), onActivate: openCamera }];
  } else if (step === "camera" && cur && !found) {
    title = routeLabel(cur.route) + " автобус хайж байна";
    primary = undefined; // an accidental double tap mustn't close the camera
    actions = [{ ...label("back", "menu_back"), onActivate: backToPlan }];
  } else if (step === "camera" && cur) {
    title = routeLabel(cur.route) + " ирлээ: хаалга руу";
    primary = 1; // "after you sit down, double tap" (door_close) -> "I'm on the bus"
    actions = [{ ...label("door", "menu_door"), onActivate: whereIsDoor }, { ...label("boarded", "menu_boarded"), onActivate: boarded }];
  } else if (step === "ride" && cur) {
    title = routeLabel(cur.route) + " автобусанд явж байна";
    actions = [{ ...label("left", "menu_stops_left"), onActivate: stopsLeft }, { ...label("off", "menu_got_off"), onActivate: gotOff }];
  } else if (step === "arrived" && plan) {
    title = (plan.transfer ? plan.transfer.alight_stop : plan.alight_stop).name.replace(/\s*\/[^/]*\//g, "") + ": ирлээ";
    primary = undefined;
    actions = [{ ...label("restart", "menu_start_over"), onActivate: startOver }];
  }
  if (sos) {
    title = "Яаралтай тусламж";
    primary = sos.mode === "sms" ? 0 : 1;
    actions = [
      { ...label("sos-send", "menu_sos_send"), onActivate: sosSend },
      { ...label("sos-call", "menu_sos_call"), onActivate: sosCall },
      { ...label("sos-cancel", "menu_sos_cancel"), onActivate: sosCancel },
    ];
  }
  // App-reads mode: the gestures are explained by "Тусламж". Screen-reader mode: talking and SOS are
  // buttons (a screen reader takes over press-and-hold), and settings sit at the end of the home screen.
  const listeningNow = step === "listening" || step === "whereListening" || step === "numberListening";
  if (mode === "voice" && !sos && !listeningNow && step !== "typing") {
    actions = actions.concat({ ...label("help", "menu_help"), onActivate: sayHelp });
  }
  const setupNow = step === "number" || step === "numberConfirm" || step === "typing";
  if (mode === "sr" && !sos && !listeningNow && !setupNow && step !== "locating" && step !== "working") {
    actions = actions.concat(
      { id: "talk", label: "Дуугаар асуух", onActivate: startTalk },
      { id: "sos", label: "Яаралтай тусламж", onActivate: sosButton },
    );
    if (step === "ask" || step === "where") {
      actions = actions.concat({ id: "settings", label: "Тохиргоо", onActivate: openSettings });
    }
  }

  if (step === "start") {
    // A screen-reader user's first swipe lands on the first button; anyone else taps anywhere.
    return (
      <main className="flow start-screen">
        <button
          className="action"
          onClick={function () {
            begin("sr");
          }}
        >
          Дэлгэц уншигчтай эхлэх (TalkBack, VoiceOver)
        </button>
        <button
          className="big start"
          onPointerUp={function () {
            begin(savedMode() ?? "voice");
          }}
          onClick={function (e) {
            if (e.detail === 0) {
              begin(savedMode() ?? "voice");
            }
          }}
        >
          Эхлэх
          <span className="hint">Дэлгэц уншигчгүй бол хаана ч хамаагүй товшино уу</span>
        </button>
      </main>
    );
  }

  if (step === "learn") {
    return (
      <main className="flow">
        <Tutorial onDone={onLearned} mode={mode} />
      </main>
    );
  }

  if (step === "settings") {
    return (
      <main className="flow">
        <Settings mode={mode} onMode={chooseMode} onDestination={typedDestination} onTutorial={replayTutorial} onBack={startOver} />
      </main>
    );
  }

  const typing = step === "typing" && (
    <TypeIn ref={typeField} key={typeFor} label={TYPE_LABEL[typeFor]} phone={typeFor === "number"} onDone={typed} />
  );

  // What the screen shows besides its buttons: the camera, or the ride's progress.
  const view = (
    <>
      {step === "camera" && cur && (
        <BusCamera
          stopId={cur.board.stop_id}
          route={cur.route}
          foundSpeech={cur.foundSpeech}
          onFound={onFound}
          onError={onCameraError}
          guide={doorGuide}
          phoneOcr={!serverOcr}
        />
      )}
      {step === "ride" && cur && (
        <RideGuide
          key={leg} // a fresh ride for the second bus
          route={cur.route}
          board={cur.board.stop_id}
          alight={cur.alight.stop_id}
          simulate={simulatedRide()}
          info={rideInfo}
          onArrived={onArrived}
        />
      )}
    </>
  );

  if (mode === "sr") {
    return (
      <main className="flow">
        <SrScreen title={title} status={speedLine ? message + " [" + speedLine + "]" : message} actions={actions}>
          {typing}
          {view}
        </SrScreen>
      </main>
    );
  }

  return (
    <main className="flow">
      <h1 className="title" aria-hidden="true">
        {title}
      </h1>
      <p className="status" aria-live="polite">
        {message}
      </p>
      {speedLine && <p className="status">{speedLine}</p>}
      {typing}
      <VoiceMenu
        key={step}
        items={actions}
        primary={primary}
        menuId={sos ? "sos" : "main"}
        intro={!listeningNow && step !== "camera" && step !== "locating" && step !== "working"}
        onHoldStart={startTalk}
        onHoldEnd={endTalk}
      >
        {view}
      </VoiceMenu>
      {(step === "ask" || step === "where") && (
        <button className="helper-link" onClick={openSettings}>
          Тохиргоо (туслагчид)
        </button>
      )}
    </main>
  );
}
