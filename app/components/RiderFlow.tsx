"use client";

// Rider journey: start -> (first time) family number for SOS -> where am I (GPS, or say / type it)
// -> say or type the destination -> one suggested bus -> camera -> "this is your bus". Every screen
// is spoken in Mongolian: its message, then its options (VoiceMenu), so a blind rider always knows
// what they can do. Anything the rider can say can also be typed (iPhone has no Mongolian speech
// recognition), and a phone number is always read back digit by digit to confirm.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { AskResponse, BoardStop, PlanResponse, PlanStop, VoiceLocateResponse } from "../../shared/contract";
import { askByText, locateByText, nearestStop, requestPlan, serverCaps, wakeServer, type ServerCaps } from "../lib/api";
import { canListen, enableChimege, enableSpeechmatics, listen, type Heard, type Listening } from "../lib/listen";
import { warmSpeech, type ListenOptions } from "../lib/speechmatics";
import { explainPermission } from "../lib/permissions";
import { keepScreenOn } from "../lib/wake";
import { GPS_OK_M, locate, type Position } from "../lib/location";
import { primeBeacon } from "../lib/beacon";
import { familyNumber, openLink, saveFamilyNumber, smsUrl, sosMessage, telUrl } from "../lib/family";
import { groupDigits, phoneDigits } from "../lib/phoneWords";
import { currentSavedReader, saveMode, setCurrentReader, subscribeReader, type Mode, type Reader } from "../lib/mode";
import { routeLabel } from "../lib/route";
import { loadDetector } from "../lib/detector";
import { prefetchStopRoutes } from "../lib/stopRoutes";
import { loadDoorDetector } from "../lib/doorDetector";
import type { DoorGuide } from "../lib/door";
import { beep, phrase, prefetch, rememberClips, say, startWaitingTick, stopSpeaking, unlockAudio, vibrate, type PhraseKey } from "../lib/speech";
import { onSpeedReport, showSpeed, speedCancel, speedMark, speedStart } from "../lib/speed";
import { wantsReader } from "../lib/reader/commands";
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
  | "confirmPlace" // "Таны байршил: X. Зөв үү?" after GPS or a said place: a wrong place means a wrong bus
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
  | "confirmDest" // the destination was a sound-alike of what was heard: "is it X?" before the trip
  | "typing" // typing instead of speaking (see typeFor)
  | "settings"; // helper / screen-reader settings: mode, family number, typed destination

type TypeFor = "number" | "dest" | "where";
const TYPE_PROMPT: Record<TypeFor, PhraseKey> = { number: "number_type_now", dest: "dest_type_now", where: "where_type_now" };
const TYPE_LABEL: Record<TypeFor, string> = { number: "Гэр бүлийн утасны дугаар", dest: "Очих газар", where: "Ойролцоох зогсоол" };
const PHONE_DIGITS = 8; // Mongolian mobile numbers
const HALF_DIGITS = 4;

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

// "Сансар ШТС /Урд/" -> "Сансар ШТС." (the pre-made stop-name clip; same as planner.stop_name).
function spokenStop(name: string): string {
  return name.replace(/\/[^/]*\/|\([^)]*\)/g, " ").split(/\s+/).filter(Boolean).join(" ") + ".";
}

// "Төв номын сан /Зүүн/" -> ["Төв номын сан.", "Зүүн тал."]: the two pre-made clips (planner.stop_pieces).
const SIDES: Record<string, string> = { урд: "Урд тал.", хойд: "Хойд тал.", зүүн: "Зүүн тал.", баруун: "Баруун тал." };
function stopPieces(name: string): string[] {
  const m = /\/\s*(Урд|Хойд|Зүүн|Баруун)\s*\//i.exec(name);
  const side = m ? SIDES[m[1].toLowerCase()] : "";
  return [spokenStop(name)].concat(side ? [side] : []);
}

// ?lat=47.91&lon=106.92 overrides GPS, for testing away from the stop.
function testPosition(): Position | null {
  const q = new URLSearchParams(window.location.search);
  const lat = parseFloat(q.get("lat") ?? "");
  const lon = parseFloat(q.get("lon") ?? "");
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, accuracy: 0 } : null;
}

export default function RiderFlow() {
  const router = useRouter();
  const [step, setStepState] = useState<Step>("start");
  const stepRef = useRef<Step>("start");
  // A new step in screen-reader mode: the app's clip waits until VoiceOver has read the short title.
  const delaySpeech = useRef(false);
  function setStep(next: Step): void {
    if (next !== stepRef.current) {
      delaySpeech.current = true;
      stepRef.current = next;
    }
    setStepState(next);
  }
  const [mode, setMode] = useState<Mode>("voice");
  const reader = useSyncExternalStore(subscribeReader, currentSavedReader, function (): Reader {
    return "app";
  });
  const readerRef = useRef<Reader>("app");
  readerRef.current = reader;
  const [serverOcr, setServerOcr] = useState(true); // false on free hosting: the phone reads the signs
  const modeRef = useRef<Mode>("voice"); // for callbacks
  // "Swipe right / double tap" only make sense without a screen reader.
  function welcome(): PhraseKey {
    return modeRef.current === "sr" ? "welcome_sr" : "welcome";
  }
  function locationAsk(): PhraseKey {
    return modeRef.current === "sr" ? "ask_location_sr" : "ask_location";
  }
  function cameraAsk(): string {
    return phrase(modeRef.current === "sr" ? "open_camera_sr" : "open_camera");
  }
  const [place, setPlace] = useState(""); // the stop the app thinks the rider is at, for the confirm screen
  const [message, setMessage] = useState("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [leg, setLeg] = useState(0); // 0: first bus, 1: second bus after the transfer
  const planRef = useRef<PlanResponse | null>(null); // for callbacks
  const legRef = useRef(0);
  const position = useRef<Position | null>(null);
  const fromGps = useRef(false); // GPS positions are refreshed on each request; a said place is kept
  const caps = useRef<ServerCaps>({ stt: true, ocr: true, speech: false, chimege: false });
  const listening = useRef<Listening | null>(null); // the microphone is on
  const [found, setFound] = useState(false); // the camera confirmed the rider's bus: now guiding to its door
  const doorGuide = useRef<DoorGuide | null>(null);
  const rideInfo = useRef<RideInfo | null>(null);
  // SOS menu on top of whatever screen (camera, ride keep running): text or call the family.
  const [sos, setSos] = useState<{ mode: "sms" | "call"; body: string } | null>(null);
  const [typeFor, setTypeFor] = useState<TypeFor>("dest");
  const typeField = useRef<HTMLInputElement>(null);
  const [pendingNumber, setPendingNumber] = useState(""); // said or typed, waiting for "correct?"
  const [guess, setGuess] = useState<PlanResponse | null>(null); // trip to a stop we're not sure was meant
  const numberNext = useRef<"find" | "ask">("find"); // where the number setup goes when done
  const numberLater = useRef(false); // "Дараа нь": not asked again until the app is opened again
  const voiceBroken = useRef(false); // this browser can't recognise Mongolian: typing from now on

  useEffect(
    function () {
      if (step !== "locating" && step !== "working") {
        return;
      }
      return startWaitingTick();
    },
    [step],
  );

  function chooseReader(next: Reader): void {
    setCurrentReader(next);
    if (next === "screen") {
      stopSpeaking();
    }
  }

  // The app's Mongolian voice, unless Settings says the screen reader should read the status.
  // On a new screen-reader step the clip starts 600 ms after the heading takes focus.
  function voice(texts: string[]): Promise<void> {
    const joined = texts
      .filter(function (item) {
        return item.trim() !== "";
      })
      .join(" ");
    if (joined) {
      setMessage(joined);
    }
    if (modeRef.current === "sr" && readerRef.current === "screen") {
      stopSpeaking();
      delaySpeech.current = false;
      return Promise.resolve();
    }
    const wait = delaySpeech.current && modeRef.current === "sr" && readerRef.current === "app";
    delaySpeech.current = false;
    if (wait) {
      return new Promise(function (resolve) {
        window.setTimeout(function () {
          resolve(say(texts));
        }, 600);
      });
    }
    return say(texts);
  }

  // Show and speak: keys are pre-made clips (instant), plain strings are made live.
  function announce(parts: (PhraseKey | { text: string })[]): Promise<void> {
    return voice(
      parts.map(function (item) {
        return typeof item === "string" ? phrase(item) : item.text;
      }),
    );
  }

  function setPlaceName(name: string): void {
    prefetch([name]); // so "Миний байршил" can say it at once
  }

  // Always say where the app thinks the rider is and let them correct it: GPS can be off by a street,
  // and speech recognition can mishear a stop name.
  function confirmPlace(name: string): void {
    setPlace(name);
    setStep("confirmPlace");
    const pieces = stopPieces(name).map(function (item) {
      return { text: item };
    });
    announce((["your_location_is"] as (PhraseKey | { text: string })[]).concat(pieces, modeRef.current === "sr" ? "place_confirm_sr" : "place_confirm"));
  }
  function placeConfirmed(): void {
    setStep("ask");
    announce([welcome()]);
  }

  function showPlan(found: PlanResponse): void {
    prefetchStopRoutes(found.board_stop.stop_id, found.routes_at_stop, found.route);
    if (found.transfer) {
      prefetchStopRoutes(found.transfer.board_stop.stop_id, [], found.transfer.route);
    }
    setPlan(found);
    planRef.current = found;
    legRef.current = 0;
    setLeg(0);
    setStep("planned");
    setMessage(found.speech.join(" "));
    // The first sentence ("34-р автобусанд суугаарай.") is pre-made, so it plays at once.
    say(found.speech.concat(cameraAsk()));
    // Camera models download while the route is read out and the rider walks to the stop (first visit
    // ~25 MB; later from the browser cache), bus detector and sign reader at the same time. Not earlier:
    // on a slow line, downloading from the start made a trip plan take 17 s instead of 1 s.
    const detecting = loadDetector();
    // Free hosting: the phone reads the sign in a worker. Warm the file cache now, while the route is
    // read out, but don't start a second copy of the model on this thread.
    const reading = caps.current.ocr
      ? Promise.resolve()
      : Promise.all(["/models/ocr_det_int8.onnx", "/models/ocr_rec_int8.onnx", "/models/ocr_keys.txt"].map(function (item) {
          return fetch(item);
        }));
    Promise.all([detecting, reading])
      .then(function ([provider]) {
        // Without WebGPU the door model would queue in front of bus detection: it loads after the "yes".
        return provider === "webgpu" ? loadDoorDetector() : undefined;
      })
      .catch(function () {
        // the camera step loads (and reports) it again
      });
  }

  // Never guess where the rider wants to go: a stop that only sounds like what was heard is asked
  // about first ("Бүрэн ойлгосонгүй. Та энэ газар руу явах уу: Сансар. Зөв үү?"), with the other
  // stops that sound alike as buttons, and "say it again".
  function planOrAsk(found: PlanResponse, heard: string): void {
    if (found.sure !== false) {
      showPlan(found);
      return;
    }
    setGuess(found);
    setStep("confirmDest");
    const name = spokenStop(found.destination.name);
    setMessage((heard ? "“" + heard + "” — " : "") + phrase("dest_unsure") + " " + name + " " + phrase("number_check"));
    say([phrase("dest_unsure"), name, phrase("number_check")]);
  }
  // The other stops that sound alike (the server sends at most 2): planned by their exact name.
  function pickAlternative(i: number): void {
    const name = guess && guess.alternatives ? guess.alternatives[i] : "";
    if (name) {
      planTrip(name);
    }
  }
  function pickFirstAlternative(): void {
    pickAlternative(0);
  }
  function pickSecondAlternative(): void {
    pickAlternative(1);
  }
  function destRight(): void {
    if (guess) {
      showPlan(guess);
    }
  }

  // GPS if it's precise enough; otherwise the rider is asked to say where they are.
  async function findMe(intro: PhraseKey[]): Promise<void> {
    setStep("locating");
    if (!testPosition()) {
      await explainPermission("geolocation", setMessage); // the first time the phone asks for location
    }
    const gps = testPosition() ? Promise.resolve(testPosition()) : locate();
    await announce(intro);
    const pos = await gps;
    if (!pos || pos.accuracy > GPS_OK_M) {
      setStep("where");
      announce([locationAsk()]);
      return;
    }
    position.current = pos;
    fromGps.current = true;
    const near = await nearestStop(pos.lat, pos.lon);
    if (near) {
      setPlaceName(near.name);
      confirmPlace(near.name);
      return;
    }
    setStep("ask"); // no stop name to say (bus data down): planning will say so
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
      enableSpeechmatics(c.speech);
      enableChimege(c.chimege); // the final text from Chimege when the server has its key
      if (c.speech) {
        warmSpeech(); // a key ready before the rider first speaks
      }
      voiceBroken.current = !canListen(); // nothing can hear Mongolian here: typing instead
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

  // The microphone, for one thing the rider says (lib/listen.ts: Speechmatics, else the browser).
  // It opens during the beep, so the rider can talk right after it, and stops by itself when they
  // stop talking. The words so far are shown for a sighted helper (not in screen-reader mode: the
  // screen reader would read them out into the microphone).
  async function hearRider(listeningStep: Step, options?: ListenOptions): Promise<Heard> {
    stopSpeaking();
    setStep(listeningStep);
    await explainPermission("microphone", setMessage); // the phone's box is visual: say what's coming
    setMessage(phrase("listening"));
    const rec = listen(showWords, options);
    listening.current = rec;
    beep();
    const heard = await rec.done;
    listening.current = null;
    warmSpeech(); // the next key, ahead of time
    return heard;
  }
  function showWords(words: string): void {
    if (modeRef.current === "voice") {
      setMessage("“" + words + "”");
    }
  }

  // Browser reason codes stay in the console. ?debug=1 also shows them, for a helper at a laptop.
  function debugNote(code?: string): string {
    if (!code) {
      return "";
    }
    console.warn(code);
    return new URLSearchParams(window.location.search).get("debug") === "1" ? " (" + code + ")" : "";
  }

  // Nothing came back from the browser's recognition: say why. A browser that can't recognise
  // Mongolian (iPhone) goes straight to typing, now and later.
  function notHeard(heard: Heard, typeInstead: TypeFor): void {
    if (heard.error === "unsupported") {
      voiceBroken.current = true;
      openTyping(typeInstead, "voice_unsupported_type", heard.code);
      return;
    }
    const missed = typeInstead === "where" && modeRef.current === "sr" ? "not_heard_where_sr" : "not_heard";
    const key = heard.error === "no-mic" ? "mic_failed" : heard.error === "network" ? "voice_network" : missed;
    say([phrase(key)]);
    setMessage(phrase(key) + (heard.error === "not-heard" ? "" : debugNote(heard.code)));
  }


  function applyPlace(result: VoiceLocateResponse | null): void {
    if (!result) {
      setStep("where");
      announce(["server_down"]);
    } else if (result.stop) {
      position.current = { lat: result.stop.lat, lon: result.stop.lon, accuracy: 0 };
      fromGps.current = false;
      setPlaceName(result.stop.name);
      confirmPlace(result.stop.name);
    } else {
      setStep("where");
      setMessage((result.heard ? "“" + result.heard + "” — " : "") + result.message);
      say([result.message ?? phrase(modeRef.current === "sr" ? "not_heard_where_sr" : "not_heard")]);
    }
  }

  async function sayWhereIAm(): Promise<void> {
    if (voiceBroken.current) {
      openTyping("where", "voice_unsupported_type");
      return;
    }
    const heard = await hearRider("whereListening");
    if (!heard.text) {
      setStep("where");
      notHeard(heard, "where");
      return;
    }
    setStep("working");
    applyPlace(await locateByText(heard.text));
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
      announce([locationAsk()]);
      return;
    }
    announce(["searching"]);
    const result = await requestPlan(text, pos.lat, pos.lon);
    if (result.ok) {
      planOrAsk(result.plan, text);
    } else {
      planFailed(text, result.message || null);
    }
  }

  async function sayDestination(): Promise<void> {
    if (voiceBroken.current) {
      openTyping("dest", "voice_unsupported_type");
      return;
    }
    const heard = await hearRider("listening");
    if (!heard.text) {
      setStep("ask");
      notHeard(heard, "dest");
      return;
    }
    planTrip(heard.text);
  }

  // ---- Family number for SOS: say it or type it, then hear it back digit by digit and confirm. ----
  function startNumberSetup(next: "find" | "ask"): void {
    numberNext.current = next;
    setStep("number");
    announce(["number_setup"]);
  }

  async function sayNumber(): Promise<void> {
    if (voiceBroken.current) {
      openTyping("number", "voice_unsupported_type");
      return;
    }
    setStep("numberListening");
    setMessage(phrase("number_say_now"));
    await say([phrase("number_say_now")]);
    const heard = await hearRider("numberListening", { digits: PHONE_DIGITS });
    if (!heard.text) {
      setStep("number");
      notHeard(heard, "number");
      return;
    }
    const digits = withoutCountryCode(phoneDigits(heard.text));
    if (digits.length === PHONE_DIGITS) {
      gotNumber(digits);
      return;
    }
    // Not the whole number (a word misheard, or a pause cut it): two halves of 4 digits, which are
    // heard far better than 8 in one go.
    await say([phrase("number_split")]);
    const first = await hearDigits("number_first_half");
    if (first === null) {
      return;
    }
    if (first.length === PHONE_DIGITS) {
      gotNumber(first); // said the whole number again: fine
      return;
    }
    const second = await hearDigits("number_second_half");
    if (second !== null) {
      gotNumber(first + second);
    }
  }

  // "976" (Mongolia's code) said first is left out; the number itself is 8 digits.
  function withoutCountryCode(digits: string): string {
    return digits.length === PHONE_DIGITS + 3 && digits.startsWith("976") ? digits.slice(3) : digits;
  }

  // Half a number (4 digits), asked once more if it wasn't heard whole. null: still not (the rider is
  // told; the number screen is back, with typing as the other option).
  async function hearDigits(ask: PhraseKey): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const key: PhraseKey = attempt ? "number_half_again" : ask;
      setStep("numberListening");
      setMessage(phrase(key));
      await say([phrase(key)]);
      const heard = await hearRider("numberListening", { digits: HALF_DIGITS });
      if (!heard.text && heard.error !== "not-heard") {
        setStep("number");
        notHeard(heard, "number");
        return null;
      }
      const digits = withoutCountryCode(phoneDigits(heard.text));
      if (digits.length === HALF_DIGITS || digits.length === PHONE_DIGITS) {
        return digits;
      }
    }
    setStep("number");
    setMessage(phrase("number_short"));
    say([phrase("number_short")]);
    return null;
  }

  // Said or typed: 8 digits are read back one by one for "correct?"; anything else is asked again.
  function gotNumber(text: string): void {
    const digits = withoutCountryCode(phoneDigits(text));
    if (digits.length !== PHONE_DIGITS) {
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
      setMessage(parts.join(" ") + debugNote(code));
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
      announce([typeFor === "dest" ? welcome() : locationAsk()]);
    }
  }

  const onFound = useCallback(function () {
    setFound(true);
    // The camera already wrote the door sentence, including the side it actually saw.
  }, []);
  const onArrived = useCallback(function () {
    const p = planRef.current;
    if (p && p.transfer && legRef.current === 0) {
      // Off bus 1 at the transfer stop: now the second bus (its speech says how far to walk, if at all).
      legRef.current = 1;
      setLeg(1);
      setFound(false);
      setStep("planned");
      const texts = [phrase("transfer_arrived")].concat(p.transfer.speech, cameraAsk());
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
    if (listening.current) {
      listening.current.stop();
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
    voice(g ? doorSpeech(g, modeRef.current === "sr") : [phrase("door_lost")]);
  }
  function boarded(): void {
    stopSpeaking();
    setStep("ride");
    setMessage(phrase("ride_start"));
  }
  function stopsLeft(): void {
    const r = rideInfo.current;
    if (r) {
      voice([leftSpeech(r.left)].concat(r.next).filter(Boolean));
    }
  }
  function gotOff(): void {
    onArrived();
  }
  function backToPlan(): void {
    stopSpeaking();
    setStep("planned");
  }
  function backToDestination(): void {
    stopSpeaking();
    setStep("ask");
    announce([welcome()]);
  }
  function hearRoute(): void {
    const p = planRef.current;
    if (!p) {
      return;
    }
    const speech = legRef.current === 1 && p.transfer ? p.transfer.speech : p.speech;
    voice(speech.concat(cameraAsk()));
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
  // #1 Screen stays on the whole time the app is open, not only on the camera and ride screens: a
  // blind rider holds the phone and listens, so a screen that never gets touched locked after 30 s -
  // 1 min, the locked page was dropped and the app started again from the beginning.
  useEffect(function () {
    keepScreenOn(true);
    return function () {
      keepScreenOn(false);
    };
  }, []);

  // #2 Back after an interruption (screen locked, a call, another app): say so and where the rider is.
  // The camera restarts itself (BusCamera), the ride's GPS too (RideGuide); this re-reads the screen.
  const stepNow = useRef<Step>("start");
  stepNow.current = step;
  const [resumed, setResumed] = useState(0); // bumps VoiceMenu's key: its options are read again
  useEffect(function () {
    let hiddenAt = 0;
    function onVisibility(): void {
      if (document.visibilityState === "hidden") {
        hiddenAt = performance.now();
        return;
      }
      const away = hiddenAt ? performance.now() - hiddenAt : 0;
      hiddenAt = 0;
      const s = stepNow.current;
      if (away < 2000 || s === "start" || s === "learn" || s === "camera") {
        return; // a blink, nothing to repeat yet, or the camera says it itself
      }
      if (s === "ride" && rideInfo.current) {
        const r = rideInfo.current;
        say([phrase("app_resumed"), leftSpeech(r.left)].concat(r.next).filter(Boolean));
      } else {
        say([phrase("app_resumed")]);
      }
      setResumed(function (n) {
        return n + 1;
      });
    }
    document.addEventListener("visibilitychange", onVisibility);
    return function () {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

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
      announce([locationAsk()]);
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
      await explainPermission("microphone", setMessage);
      // The microphone opens while the beep plays, so the rider can talk right after it.
      const rec = listen(showWords);
      session.stop = rec.stop;
      if (released) {
        rec.stop();
      }
      beep();
      const heard = await rec.done;
      talk.current = null;
      warmSpeech();
      if (!heard.text) {
        speedCancel();
        if (heard.error === "unsupported") {
          // Asking by voice isn't possible here; every menu (and typing) still is.
          voiceBroken.current = true;
          announce(["voice_unsupported"]);
        } else {
          notHeard(heard, "dest");
        }
        return;
      }
      if (wantsReader(heard.text)) {
        speedCancel();
        openReader(); // "энийг уншаад өг", "ном унших": the reader, not the bus assistant
        return;
      }
      sayWaitIfSlow();
      const result: AskResponse | null = await askByText(heard.text, pos.lat, pos.lon, context);
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

  // The reader (/read): same tab, so sound stays unlocked and it starts at once.
  function openReader(): void {
    stopSpeaking();
    router.push("/read?from=app");
  }

  function doAction(result: AskResponse): void {
    const a = result.action;
    if (a === "plan" && result.plan && result.plan.sure === false) {
      planOrAsk(result.plan, result.heard);
    } else if (a === "plan" && result.plan) {
      showPlan(result.plan);
      say(result.speech.concat(cameraAsk()));
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
    const sosKey = mode === "sms" ? (modeRef.current === "sr" ? "sos_confirm_sr" : "sos_confirm") : modeRef.current === "sr" ? "sos_call_confirm_sr" : "sos_call_confirm";
    say([phrase(sosKey)]);
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
  } else if (step === "confirmPlace") {
    title = place.replace(/\s*\/[^/]*\//g, "") + ": зөв үү?";
    const yes = { ...label("place-yes", "menu_place_yes"), onActivate: placeConfirmed };
    const sayWhere = { ...label("say-where", "menu_say_where"), onActivate: sayWhereIAm };
    // "Буруу бол баруун тийш шудраад": the first swipe right must land on saying the place, and a
    // double tap before any swipe means "yes". A screen reader meets "Тийм" first.
    actions = mode === "sr" ? [yes, sayWhere] : [sayWhere, yes];
    primary = mode === "sr" ? 0 : 1;
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
      { ...label("read", "menu_read"), onActivate: openReader },
    ];
  } else if (step === "number") {
    title = "Яаралтай тусламжийн дугаар";
    actions = [
      { ...label("number-say", "menu_number_say"), onActivate: sayNumber },
      { ...label("number-type", "menu_number_type"), onActivate: typeNumber },
      { ...label("number-later", "menu_later"), onActivate: numberPutOff },
    ];
  } else if (step === "confirmDest" && guess) {
    title = spokenStop(guess.destination.name).replace(/\.$/, "") + " — зөв үү?";
    actions = [{ ...label("dest-yes", "menu_yes_correct"), onActivate: destRight }];
    const alts = guess.alternatives ?? [];
    // The stop-name clip is the name with a full stop.
    if (alts[0]) {
      actions = actions.concat({ id: "dest-alt-0", label: alts[0], speech: [alts[0] + "."], onActivate: pickFirstAlternative });
    }
    if (alts[1]) {
      actions = actions.concat({ id: "dest-alt-1", label: alts[1], speech: [alts[1] + "."], onActivate: pickSecondAlternative });
    }
    actions = actions.concat({ ...label("dest-again", "menu_say_again"), onActivate: sayDestination });
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
  if (step === "planned" && cur && !sos) {
    actions = actions.concat(
      { ...label("plan-back", "menu_back"), onActivate: backToDestination },
      { ...label("plan-again", "menu_hear_again"), onActivate: hearRoute },
    );
  }

  if (step === "start") {
    // Two equal halves. The screen-reader choice is first, so a VoiceOver user's first swipe
    // lands there. The big "Эхлэх" used to open the gesture screen, which VoiceOver blocks.
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
        <Settings
          mode={mode}
          reader={reader}
          onMode={chooseMode}
          onReader={chooseReader}
          onDestination={typedDestination}
          onTutorial={replayTutorial}
          onBack={startOver}
        />
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
          onAnnounce={voice}
          screenReader={mode === "sr"}
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
          onAnnounce={voice}
        />
      )}
    </>
  );

  if (mode === "sr") {
    return (
      <main className="flow">
        <SrScreen
          title={title}
          stepId={sos ? "sos" : step}
          status={speedLine ? message + " [" + speedLine + "]" : message}
          live={reader === "screen"}
          actions={actions}
        >
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
        key={step + "-" + resumed}
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
