"use client";

// Rider journey: start -> where am I (GPS, or say it) -> say destination -> one suggested bus ->
// camera -> "this is your bus". Every screen is a VoiceMenu: swipe to hear the options, double tap
// to choose, all spoken in Mongolian, so a blind rider always knows what they can do.
import { useCallback, useRef, useState, type FormEvent } from "react";
import type { PlanResponse, VoiceLocateResponse } from "../../shared/contract";
import { locateBySpeech, locateByText, nearestStop, requestPlan, requestVoicePlan } from "../lib/api";
import { GPS_OK_M, locate, type Position } from "../lib/location";
import { beep, record, type Recording } from "../lib/record";
import { primeBeacon } from "../lib/beacon";
import type { DoorGuide } from "../lib/door";
import { phrase, prefetch, say, stopSpeaking, unlockAudio, type PhraseKey } from "../lib/speech";
import BusCamera, { doorSpeech } from "./BusCamera";
import PlanCard from "./PlanCard";
import RideGuide, { leftSpeech, type RideInfo } from "./RideGuide";
import VoiceMenu, { type MenuItem } from "./VoiceMenu";

type Step =
  | "start"
  | "locating"
  | "where"
  | "whereListening"
  | "ask"
  | "listening"
  | "working"
  | "planned"
  | "camera" // find the bus, then guide to its door
  | "ride" // on the bus, until the rider's stop
  | "arrived";

// ?ride=sim, or a demo photo instead of the camera: the bus drives the real stops at demo speed.
function simulatedRide(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.get("ride") === "sim" || q.has("image") || q.has("video");
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
  const [message, setMessage] = useState("");
  const [typed, setTyped] = useState("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [heard, setHeard] = useState("");
  const [place, setPlace] = useState(""); // where the app thinks the rider is
  const position = useRef<Position | null>(null);
  const fromGps = useRef(false); // GPS positions are refreshed on each request; a said place is kept
  const recording = useRef<Recording | null>(null);
  const [found, setFound] = useState(false); // the camera confirmed the rider's bus: now guiding to its door
  const doorGuide = useRef<DoorGuide | null>(null);
  const rideInfo = useRef<RideInfo | null>(null);

  // Show and speak: keys are pre-made clips (instant), plain strings are made live.
  function announce(parts: (PhraseKey | { text: string })[]): Promise<void> {
    const texts = parts.map(function (item) {
      return typeof item === "string" ? phrase(item) : item.text;
    });
    setMessage(texts.join(" "));
    return say(texts);
  }

  function setPlaceName(name: string): void {
    setPlace(name);
    prefetch([name]); // so "Миний байршил" can say it at once
  }

  function showPlan(found: PlanResponse, heardText: string): void {
    setHeard(heardText);
    setPlan(found);
    setStep("planned");
    setMessage(found.speech.join(" "));
    // The first sentence ("34-р автобусанд суугаарай.") is pre-made, so it plays at once.
    say(found.speech.concat(phrase("open_camera")));
  }

  // GPS if it's precise enough; otherwise the rider is asked to say where they are.
  async function findMe(intro: PhraseKey[]): Promise<void> {
    setStep("locating");
    const gps = testPosition() ? Promise.resolve(testPosition()) : locate();
    await announce(intro);
    const pos = await gps;
    if (!pos || pos.accuracy > GPS_OK_M) {
      setPlace("");
      setStep("where");
      announce(["ask_location"]);
      return;
    }
    position.current = pos;
    fromGps.current = true;
    const near = await nearestStop(pos.lat, pos.lon);
    setPlaceName(near ? near.name : "GPS ±" + Math.round(pos.accuracy) + " м");
    setStep("ask");
    announce(["location_ok", "welcome"]);
  }

  function begin(): void {
    unlockAudio(); // inside the first touch, or iPhones stay silent
    findMe(["tutorial", "locating"]);
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
      announce(["location_ok", "welcome"]);
    } else {
      setStep("where");
      setMessage((result.heard ? "“" + result.heard + "” — " : "") + result.message);
      say([result.message ?? phrase("not_heard")]);
    }
  }

  async function sayWhereIAm(): Promise<void> {
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
      showPlan(result.plan, text);
    } else {
      planFailed(text, result.message || null);
    }
  }

  async function sayDestination(): Promise<void> {
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
      showPlan(result.plan, result.heard);
    } else {
      planFailed(result ? result.heard : "", result ? result.message : null);
    }
  }

  async function submitTyped(e: FormEvent): Promise<void> {
    e.preventDefault();
    const text = typed.trim();
    if (!text) {
      return;
    }
    stopSpeaking();
    setTyped("");
    if (step === "where") {
      setStep("working");
      applyPlace(await locateByText(text));
    } else {
      planTrip(text);
    }
  }

  function goWhere(): void {
    setStep("where");
    announce(["where_are_you"]);
  }

  const onFound = useCallback(function () {
    setFound(true);
  }, []);
  const onArrived = useCallback(function () {
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
  }
  function sayMyLocation(): void {
    announce(["your_location_is", { text: place }]);
  }
  function retryGps(): void {
    findMe(["locating"]);
  }
  function openCamera(): void {
    stopSpeaking();
    primeBeacon(); // inside the double tap, or iPhones won't play the door beacon
    setFound(false);
    setStep("camera");
  }
  function whereIsDoor(): void {
    const g = doorGuide.current;
    say(g ? doorSpeech(g) : [phrase("door_lost")]);
  }
  function boarded(): void {
    stopSpeaking();
    setStep("ride");
  }
  function stopsLeft(): void {
    const r = rideInfo.current;
    if (r) {
      say([leftSpeech(r.left), r.next].filter(Boolean));
    }
  }
  function gotOff(): void {
    onArrived();
  }
  function repeatRoute(): void {
    if (plan) {
      announce(
        plan.speech.map(function (text) {
          return { text };
        }),
      );
    }
  }
  function otherDestination(): void {
    setStep("ask");
    announce(["welcome"]);
  }
  function backToPlan(): void {
    stopSpeaking();
    setStep("planned");
  }
  function startOver(): void {
    setPlan(null);
    setStep("ask");
    announce(["welcome"]);
  }

  const help: MenuItem = { ...label("help", "menu_help"), onActivate: sayHelp };
  const changeLocation: MenuItem = { ...label("move", "menu_change_location"), onActivate: goWhere };
  const myLocation: MenuItem = {
    ...label("here", "menu_my_location"),
    speech: [phrase("menu_my_location"), phrase("your_location_is"), place],
    onActivate: sayMyLocation,
  };

  // The options on each screen; the first is what a double tap does before any swipe.
  let items: MenuItem[] = [];
  let primary: number | undefined = 0;
  if (step === "where") {
    items = [
      { ...label("say-where", "menu_say_where"), onActivate: sayWhereIAm },
      { ...label("gps", "menu_retry_gps"), onActivate: retryGps },
      help,
    ];
  } else if (step === "ask") {
    items = [{ ...label("say-dest", "menu_say_destination"), onActivate: sayDestination }, myLocation, changeLocation, help];
  } else if (step === "listening" || step === "whereListening") {
    items = [{ ...label("stop", "menu_stop_listening"), onActivate: stopRecording }];
  } else if (step === "planned") {
    items = [
      { ...label("camera", "menu_open_camera"), onActivate: openCamera },
      { ...label("repeat", "menu_repeat_route"), onActivate: repeatRoute },
      { ...label("other", "menu_other_destination"), onActivate: otherDestination },
      changeLocation,
      help,
    ];
  } else if (step === "camera" && !found) {
    primary = undefined; // an accidental double tap mustn't close the camera
    items = [
      { ...label("repeat", "menu_repeat_route"), onActivate: repeatRoute },
      { ...label("back", "menu_back"), onActivate: backToPlan },
      help,
    ];
  } else if (step === "camera") {
    // At the door: "after you sit down, double tap" (door_close) -> the main action is "I'm on the bus".
    primary = 1;
    items = [
      { ...label("door", "menu_door"), onActivate: whereIsDoor },
      { ...label("boarded", "menu_boarded"), onActivate: boarded },
      { ...label("repeat", "menu_repeat_route"), onActivate: repeatRoute },
      { ...label("back", "menu_back"), onActivate: backToPlan },
      help,
    ];
  } else if (step === "ride") {
    items = [
      { ...label("left", "menu_stops_left"), onActivate: stopsLeft },
      { ...label("off", "menu_got_off"), onActivate: gotOff },
      help,
    ];
  } else if (step === "arrived") {
    primary = undefined;
    items = [{ ...label("restart", "menu_start_over"), onActivate: startOver }, help];
  }

  if (step === "start") {
    return (
      <main className="flow">
        <button className="big start" onPointerUp={begin} onClick={function (e) { if (e.detail === 0) begin(); }}>
          Эхлэх
          <span className="hint">Дэлгэцийн хаана ч хамаагүй товшино уу</span>
        </button>
      </main>
    );
  }

  return (
    <main className="flow">
      <p className="message" aria-live="polite">
        {message}
      </p>
      {place && (step === "ask" || step === "listening") && <p className="place">Таны байршил: {place}</p>}

      <VoiceMenu key={step} items={items} primary={primary}>
        {step === "planned" && plan && <PlanCard plan={plan} heard={heard} />}
        {step === "camera" && plan && (
          <>
            {found ? (
              <p className="found" role="alert">
                {plan.route} ТАНЫ АВТОБУС · хаалга руу
              </p>
            ) : (
              <p className="route-banner">{plan.route}</p>
            )}
            <BusCamera
              stopId={plan.board_stop.stop_id}
              route={plan.route}
              foundSpeech={plan.found_speech}
              onFound={onFound}
              onError={onCameraError}
              guide={doorGuide}
            />
          </>
        )}
        {step === "ride" && plan && (
          <>
            <p className="route-banner">{plan.route}</p>
            <RideGuide
              route={plan.route}
              board={plan.board_stop.stop_id}
              alight={plan.alight_stop.stop_id}
              simulate={simulatedRide()}
              info={rideInfo}
              onArrived={onArrived}
            />
          </>
        )}
        {step === "arrived" && plan && (
          <p className="found" role="alert">
            {plan.alight_stop.name}
            <br />
            ИРЛЭЭ
          </p>
        )}
      </VoiceMenu>

      {(step === "where" || step === "ask") && (
        <form className="typed" onSubmit={submitTyped}>
          <label htmlFor="dest">{step === "where" ? "Байгаа газраа бичих:" : "Очих газраа бичих:"}</label>
          <input
            id="dest"
            value={typed}
            onChange={function (e) {
              setTyped(e.target.value);
            }}
            placeholder={step === "where" ? "Төв номын сан" : "Сансар"}
          />
          <button type="submit">OK</button>
        </form>
      )}
    </main>
  );
}
