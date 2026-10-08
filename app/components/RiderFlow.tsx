"use client";

// Rider journey: start -> say destination -> GPS -> one suggested bus -> camera -> "this is your bus".
// Every step is spoken in Mongolian; each screen is one big tap target.
import { useCallback, useRef, useState, type FormEvent } from "react";
import type { PlanResponse } from "../../shared/contract";
import { requestPlan, requestVoicePlan } from "../lib/api";
import { locate, type Position } from "../lib/location";
import { beep, record, type Recording } from "../lib/record";
import { phrase, say, sayPhrase, stopSpeaking, type PhraseKey } from "../lib/speech";
import BusCamera from "./BusCamera";
import PlanCard from "./PlanCard";

type Step = "start" | "ask" | "listening" | "working" | "planned" | "camera" | "found";

// ?lat=47.91&lon=106.92 overrides GPS, for testing away from the stop.
function testPosition(): Position | null {
  const q = new URLSearchParams(window.location.search);
  const lat = parseFloat(q.get("lat") ?? "");
  const lon = parseFloat(q.get("lon") ?? "");
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export default function RiderFlow() {
  const [step, setStep] = useState<Step>("start");
  const [message, setMessage] = useState("");
  const [typed, setTyped] = useState("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [heard, setHeard] = useState("");
  // GPS is asked for while the rider is still talking, so it never adds to the wait.
  const position = useRef<Promise<Position | null> | null>(null);
  const recording = useRef<Recording | null>(null);

  function refreshPosition(): void {
    const test = testPosition();
    position.current = test ? Promise.resolve(test) : locate();
  }

  function showPlan(found: PlanResponse, heardText: string): void {
    setHeard(heardText);
    setPlan(found);
    setStep("planned");
    setMessage(found.speech.join(" "));
    // The first sentence ("34-р автобусанд суугаарай.") is pre-made, so it plays at once.
    say(found.speech.concat(phrase("open_camera")));
  }

  function tell(key: PhraseKey): Promise<void> {
    setMessage(phrase(key));
    return sayPhrase(key);
  }

  function begin(): void {
    // The first tap also unlocks audio playback on phones.
    setStep("ask");
    refreshPosition();
    tell("welcome");
  }

  async function planTrip(text: string): Promise<void> {
    setStep("working");
    setMessage("“" + text + "”");
    refreshPosition();
    const pos = await position.current;
    if (!pos) {
      tell("location_failed");
      setStep("ask");
      return;
    }
    tell("searching");
    const result = await requestPlan(text, pos.lat, pos.lon);
    if (!result.ok) {
      if (result.message) {
        setMessage(result.message);
        say([result.message]);
      } else {
        tell("server_down");
      }
      setStep("ask");
      return;
    }
    showPlan(result.plan, "");
  }

  // Tap, beep, say the stop; recording ends by itself ~0.7 s after the rider stops talking
  // (or on a second tap), and one request returns the bus.
  async function ask(): Promise<void> {
    if (recording.current) {
      recording.current.stop();
      return;
    }
    stopSpeaking();
    refreshPosition();
    setStep("listening");
    setMessage("");
    await beep();
    recording.current = record();
    const wav = await recording.current.done;
    recording.current = null;
    if (!wav) {
      tell("not_heard");
      setStep("ask");
      return;
    }
    setStep("working");
    const pos = await position.current;
    if (!pos) {
      tell("location_failed");
      setStep("ask");
      return;
    }
    const result = await requestVoicePlan(wav, pos.lat, pos.lon);
    if (!result) {
      tell("server_down");
      setStep("ask");
    } else if (result.plan) {
      showPlan(result.plan, result.heard);
    } else {
      setMessage((result.heard ? "“" + result.heard + "” — " : "") + result.message);
      say([result.message ?? phrase("not_heard")]);
      setStep("ask");
    }
  }

  function submitTyped(e: FormEvent): void {
    e.preventDefault();
    if (typed.trim()) {
      stopSpeaking();
      planTrip(typed.trim());
    }
  }

  const onFound = useCallback(function () {
    setStep("found");
  }, []);
  const onCameraError = useCallback(function () {
    setStep("planned");
  }, []);

  return (
    <main className="flow">
      <p className="message" aria-live="polite">
        {message}
      </p>

      {step === "start" && (
        <button className="big" onClick={begin}>
          Эхлэх
        </button>
      )}

      {(step === "ask" || step === "listening") && (
        <>
          <button className={step === "listening" ? "big listening" : "big"} onClick={ask}>
            {step === "listening" ? "Сонсож байна…" : "Дарж очих газраа хэлнэ үү"}
          </button>
          <form className="typed" onSubmit={submitTyped}>
            <label htmlFor="dest">Эсвэл бичих:</label>
            <input id="dest" value={typed} onChange={function (e) { setTyped(e.target.value); }} placeholder="Сансар" />
            <button type="submit">Хайх</button>
          </form>
        </>
      )}

      {step === "working" && <p className="big busy">Түр хүлээнэ үү…</p>}

      {step === "planned" && plan && (
        <>
          <PlanCard plan={plan} heard={heard} />
          <button className="big" onClick={function () { stopSpeaking(); setStep("camera"); }}>
            Камер нээх
          </button>
          <button className="small" onClick={function () { setStep("ask"); }}>
            Өөр газар
          </button>
        </>
      )}

      {step === "camera" && plan && (
        <>
          <p className="route-banner">{plan.route}</p>
          <BusCamera
            stopId={plan.board_stop.stop_id}
            route={plan.route}
            foundSpeech={plan.found_speech}
            onFound={onFound}
            onError={onCameraError}
          />
          <button className="small" onClick={function () { stopSpeaking(); setStep("planned"); }}>
            Буцах
          </button>
        </>
      )}

      {step === "found" && plan && (
        <>
          <p className="big found" role="alert">
            {plan.route}
            <br />
            ТАНЫ АВТОБУС
          </p>
          <button className="small" onClick={function () { setStep("camera"); }}>
            Дахин шалгах
          </button>
          <button className="small" onClick={function () { setPlan(null); setStep("ask"); tell("welcome"); }}>
            Шинээр эхлэх
          </button>
        </>
      )}
    </main>
  );
}
