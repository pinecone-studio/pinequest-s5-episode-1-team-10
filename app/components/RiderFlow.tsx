"use client";

// Rider journey: start -> where am I (GPS, or say it) -> say destination -> one suggested bus ->
// camera -> "this is your bus". Every screen is a VoiceMenu: swipe to hear the options, double tap
// to choose, all spoken in Mongolian, so a blind rider always knows what they can do.
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import type { AskResponse, BoardStop, PlanResponse, PlanStop, VoiceLocateResponse } from "../../shared/contract";
import { askByText, askByVoice, locateBySpeech, locateByText, nearestStop, requestPlan, requestVoicePlan, serverCaps, type ServerCaps } from "../lib/api";
import { listenInBrowser } from "../lib/listen";
import { GPS_OK_M, locate, type Position } from "../lib/location";
import { beep, record, type Recording } from "../lib/record";
import { primeBeacon } from "../lib/beacon";
import { requestCompassPermission } from "../lib/compass";
import { familyNumber, openLink, smsUrl, sosMessage, telUrl } from "../lib/family";
import { routeLabel } from "../lib/route";
import { loadDetector } from "../lib/detector";
import { loadDoorDetector } from "../lib/doorDetector";
import type { DoorGuide } from "../lib/door";
import { phrase, prefetch, say, stopSpeaking, unlockAudio, vibrate, type PhraseKey } from "../lib/speech";
import BusCamera, { doorSpeech } from "./BusCamera";
import PlanCard from "./PlanCard";
import RideGuide, { leftSpeech, type RideInfo } from "./RideGuide";
import Tutorial, { tutorialNeeded } from "./Tutorial";
import FamilyContact from "./FamilyContact";
import WalkGuide from "./WalkGuide";
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
  | "walk" // walking to the boarding stop: compass direction + distance
  | "camera" // find the bus, then guide to its door
  | "ride" // on the bus, until the rider's stop
  | "arrived";

// ?ride=sim, or a demo photo instead of the camera: the bus drives the real stops at demo speed.
function simulatedRide(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.get("ride") === "sim" || q.has("image") || q.has("video");
}

// ?walk=sim: a simulated walk to the stop (pitch stage, desk testing), even when already close to it.
function simulatedWalk(): boolean {
  return new URLSearchParams(window.location.search).get("walk") === "sim";
}

const AT_STOP_M = 30;

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
} // closer than this to the boarding stop: no walking guidance needed

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
  const [leg, setLeg] = useState(0); // 0: first bus, 1: second bus after the transfer
  const planRef = useRef<PlanResponse | null>(null); // for callbacks
  const legRef = useRef(0);
  const [heard, setHeard] = useState("");
  const [place, setPlace] = useState(""); // where the app thinks the rider is
  const position = useRef<Position | null>(null);
  const fromGps = useRef(false); // GPS positions are refreshed on each request; a said place is kept
  const recording = useRef<Recording | null>(null);
  const caps = useRef<ServerCaps>({ stt: true, ocr: true });
  const browserListening = useRef<{ stop: () => void } | null>(null);
  const [found, setFound] = useState(false); // the camera confirmed the rider's bus: now guiding to its door
  const doorGuide = useRef<DoorGuide | null>(null);
  const rideInfo = useRef<RideInfo | null>(null);
  const walkInfo = useRef<string[] | null>(null);
  const [atStop, setAtStop] = useState(true); // false: offer walking guidance to the boarding stop first
  // SOS menu on top of whatever screen (camera, ride keep running): text or call the family.
  const [sos, setSos] = useState<{ mode: "sms" | "call"; body: string } | null>(null);
  const [walkFrom, setWalkFrom] = useState<{ lat: number; lon: number } | null>(null); // rider's position when the walk starts

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
    planRef.current = found;
    legRef.current = 0;
    setLeg(0);
    const far = found.board_stop.distance_m >= AT_STOP_M || simulatedWalk();
    setAtStop(!far);
    setStep("planned");
    setMessage(found.speech.join(" "));
    // The first sentence ("34-р автобусанд суугаарай.") is pre-made, so it plays at once.
    say(found.speech.concat(phrase(far ? "plan_walk" : "open_camera")));
    // Load + warm both models while the route is read out, so the camera detects from its first frame.
    loadDetector()
      .then(function (provider) {
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
    primeBeacon(); // the lesson's ear check plays the door beacon
    serverCaps().then(function (c) {
      caps.current = c;
    });
    if (tutorialNeeded()) {
      setStep("learn");
    } else {
      findMe(["locating"]);
    }
  }

  // After the lesson: find the rider (first time) or go back to choosing a destination (replay from Help).
  const onLearned = useCallback(function () {
    if (position.current) {
      setStep("ask");
      announce(["welcome"]);
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
  async function hearInBrowser(listeningStep: Step): Promise<string> {
    stopSpeaking();
    setStep(listeningStep);
    setMessage(phrase("menu_stop_listening"));
    await beep();
    const rec = listenInBrowser();
    browserListening.current = rec;
    const text = await rec.done;
    browserListening.current = null;
    return text;
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
    if (!caps.current.stt) {
      const text = await hearInBrowser("whereListening");
      if (!text) {
        setStep("where");
        announce(["not_heard"]);
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
      showPlan(result.plan, text);
    } else {
      planFailed(text, result.message || null);
    }
  }

  async function sayDestination(): Promise<void> {
    if (!caps.current.stt) {
      const text = await hearInBrowser("listening");
      if (!text) {
        setStep("ask");
        announce(["not_heard"]);
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
    const p = planRef.current;
    if (p && p.transfer && legRef.current === 0) {
      // Off bus 1 at the transfer stop: now the second bus (walk there first if it's across the street).
      legRef.current = 1;
      setLeg(1);
      const far = p.transfer.board_stop.distance_m >= AT_STOP_M;
      setAtStop(!far);
      setFound(false);
      setStep("planned");
      const texts = [phrase("transfer_arrived")].concat(p.transfer.speech, phrase(far ? "plan_walk" : "open_camera"));
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
  function sayMyLocation(): void {
    announce(["your_location_is", { text: place }]);
  }
  function retryGps(): void {
    findMe(["locating"]);
  }
  function startWalk(): void {
    stopSpeaking();
    primeBeacon(); // inside the double tap (iPhone)
    requestCompassPermission(); // iPhone asks only inside a tap
    const p = position.current;
    setWalkFrom(p ? { lat: p.lat, lon: p.lon } : null);
    setStep("walk");
  }
  function whereIsStop(): void {
    say(walkInfo.current ?? [phrase("wait")]);
  }
  const onWalked = useCallback(function () {
    setAtStop(true);
    setStep("planned");
    setMessage(phrase("walk_arrived"));
  }, []);
  // Stable props for WalkGuide (a new object each render would restart its GPS and compass).
  const walkStop = useMemo(
    function () {
      if (!plan) {
        return null;
      }
      const b = legOf(plan, leg).board;
      return { lat: b.lat, lon: b.lon, name: b.name };
    },
    [plan, leg],
  );

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
      say([leftSpeech(r.left)].concat(r.next).filter(Boolean));
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
    planRef.current = null;
    legRef.current = 0;
    setLeg(0);
    setStep("ask");
    announce(["welcome"]);
  }

  // Voice assistant: the rider says anything (a question or a command) on any screen. It records in
  // place, so the camera, walk or ride keeps running; the server answers from our bus data only and may
  // name an action ("plan", "open_camera", "door"...), which is done here like the menu option would.
  async function askQuestion(): Promise<void> {
    const pos = position.current;
    if (!pos) {
      announce(["ask_location"]);
      return;
    }
    const leg = plan ? legOf(plan, legRef.current) : null;
    const context = { step, route: leg ? leg.route : "", alight: leg ? leg.alight.name : "" };
    stopSpeaking();
    setMessage(phrase("listening"));
    await beep();
    let result: AskResponse | null;
    if (!caps.current.stt) {
      const text = await listenInBrowser().done;
      if (!text) {
        announce(["not_heard"]);
        return;
      }
      say([phrase("wait")]);
      result = await askByText(text, pos.lat, pos.lon, context);
    } else {
      const rec = record();
      recording.current = rec;
      const wav = await rec.done;
      recording.current = null;
      if (!wav) {
        announce([rec.noMic() ? "mic_failed" : "not_heard"]);
        return;
      }
      say([phrase("wait")]); // a new sentence's voice is made live (~8 s); fixed ones play at once
      result = await askByVoice(wav, pos.lat, pos.lon, context);
    }
    if (!result) {
      announce(["server_down"]);
      return;
    }
    setMessage(result.heard && result.answer ? "“" + result.heard + "” — " + result.answer : result.answer || "“" + result.heard + "”");
    doAction(result);
  }

  function doAction(result: AskResponse): void {
    const a = result.action;
    if (a === "plan" && result.plan) {
      showPlan(result.plan, result.heard);
      say(result.speech.concat(phrase(result.plan.board_stop.distance_m >= AT_STOP_M ? "plan_walk" : "open_camera")));
    } else if (a === "open_camera") {
      openCamera();
    } else if (a === "walk") {
      startWalk();
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
      setMessage(phrase("sos_no_contact") + " " + where);
      say([phrase("sos_no_contact")].concat(result.speech.slice(1)));
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

  const help: MenuItem = { ...label("help", "menu_help"), onActivate: sayHelp };
  const askItem: MenuItem = { ...label("ask-question", "menu_ask"), onActivate: askQuestion };
  const tutorial: MenuItem = { ...label("tutorial", "menu_tutorial"), onActivate: replayTutorial };
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
      askItem,
      help,
      tutorial,
    ];
  } else if (step === "ask") {
    items = [{ ...label("say-dest", "menu_say_destination"), onActivate: sayDestination }, myLocation, changeLocation, askItem, help, tutorial];
  } else if (step === "listening" || step === "whereListening") {
    items = [{ ...label("stop", "menu_stop_listening"), onActivate: stopRecording }];
  } else if (step === "planned") {
    const camera: MenuItem = { ...label("camera", "menu_open_camera"), onActivate: openCamera };
    const walk: MenuItem = { ...label("walk", "menu_walk"), onActivate: startWalk };
    const repeat: MenuItem = { ...label("repeat", "menu_repeat_route"), onActivate: repeatRoute };
    const other: MenuItem = { ...label("other", "menu_other_destination"), onActivate: otherDestination };
    // Far from the stop: guiding there comes first; at the stop: the camera.
    items = atStop ? [camera, walk, repeat, other, changeLocation, askItem, help] : [walk, camera, repeat, other, changeLocation, askItem, help];
  } else if (step === "walk") {
    items = [
      { ...label("where-stop", "menu_where_stop"), onActivate: whereIsStop },
      { ...label("camera", "menu_open_camera"), onActivate: openCamera },
      { ...label("repeat", "menu_repeat_route"), onActivate: repeatRoute },
      { ...label("back", "menu_back"), onActivate: backToPlan },
      askItem,
      help,
    ];
  } else if (step === "camera" && !found) {
    primary = undefined; // an accidental double tap mustn't close the camera
    items = [
      { ...label("repeat", "menu_repeat_route"), onActivate: repeatRoute },
      { ...label("back", "menu_back"), onActivate: backToPlan },
      askItem,
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
      askItem,
      help,
    ];
  } else if (step === "ride") {
    items = [
      { ...label("left", "menu_stops_left"), onActivate: stopsLeft },
      { ...label("off", "menu_got_off"), onActivate: gotOff },
      askItem,
      help,
    ];
  } else if (step === "arrived") {
    primary = undefined;
    items = [{ ...label("restart", "menu_start_over"), onActivate: startOver }, askItem, help];
  }

  if (sos) {
    primary = sos.mode === "sms" ? 0 : 1;
    items = [
      { ...label("sos-send", "menu_sos_send"), onActivate: sosSend },
      { ...label("sos-call", "menu_sos_call"), onActivate: sosCall },
      { ...label("sos-cancel", "menu_sos_cancel"), onActivate: sosCancel },
    ];
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

  const cur = plan ? legOf(plan, leg) : null; // the bus the rider is taking now

  if (step === "learn") {
    return (
      <main className="flow">
        <Tutorial onDone={onLearned} />
      </main>
    );
  }

  return (
    <main className="flow">
      <p className="message" aria-live="polite">
        {message}
      </p>
      {place && (step === "ask" || step === "listening") && <p className="place">Таны байршил: {place}</p>}

      <VoiceMenu key={step} items={items} primary={primary} menuId={sos ? "sos" : "main"}>
        {step === "planned" && plan && <PlanCard plan={plan} heard={heard} leg={leg} />}
        {step === "walk" && cur && walkStop && (
          <>
            <p className="route-banner">{routeLabel(cur.route)}</p>
            <WalkGuide stop={walkStop} start={walkFrom} simulate={simulatedWalk()} info={walkInfo} onArrived={onWalked} />
          </>
        )}
        {step === "camera" && cur && (
          <>
            {found ? (
              <p className="found" role="alert">
                {routeLabel(cur.route)} ТАНЫ АВТОБУС · хаалга руу
              </p>
            ) : (
              <p className="route-banner">{routeLabel(cur.route)}</p>
            )}
            <BusCamera
              stopId={cur.board.stop_id}
              route={cur.route}
              foundSpeech={cur.foundSpeech}
              onFound={onFound}
              onError={onCameraError}
              guide={doorGuide}
            />
          </>
        )}
        {step === "ride" && cur && (
          <>
            <p className="route-banner">{routeLabel(cur.route)}</p>
            <RideGuide
              key={leg} // a fresh ride for the second bus
              route={cur.route}
              board={cur.board.stop_id}
              alight={cur.alight.stop_id}
              simulate={simulatedRide()}
              info={rideInfo}
              onArrived={onArrived}
            />
          </>
        )}
        {step === "arrived" && plan && (
          <p className="found" role="alert">
            {(plan.transfer ? plan.transfer.alight_stop : plan.alight_stop).name}
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
      {step === "ask" && <FamilyContact />}
    </main>
  );
}
