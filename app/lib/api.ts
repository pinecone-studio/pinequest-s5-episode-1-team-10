// Calls to the FastAPI server, proxied under /api (next.config.ts).
import type { AskResponse, NearestStop, PlanResponse, VerifyRequest, VerifyResponse, VoiceLocateResponse, VoicePlanResponse } from "../../shared/contract";
import { VERIFY_TIMEOUT_MS } from "../../shared/contract";

export type PlanResult = { ok: true; plan: PlanResponse } | { ok: false; message: string };


export async function requestPlan(text: string, lat: number, lon: number): Promise<PlanResult> {
  let res: Response;
  try {
    res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lat, lon }),
    });
  } catch {
    return { ok: false, message: "" };
  }
  if (res.ok) {
    return { ok: true, plan: (await res.json()) as PlanResponse };
  }
  // 404 detail is a Mongolian sentence meant for the rider; anything else is "server down".
  const body = await res.json().catch(function () {
    return {};
  });
  return { ok: false, message: res.status === 404 && typeof body.detail === "string" ? body.detail : "" };
}

// Speech recognition + plan in one round trip. null = server unreachable or down.
export async function requestVoicePlan(wav: Blob, lat: number, lon: number): Promise<VoicePlanResponse | null> {
  try {
    const res = await fetch("/api/plan/voice?lat=" + lat + "&lon=" + lon, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    return res.ok ? ((await res.json()) as VoicePlanResponse) : null;
  } catch {
    return null;
  }
}

// Voice assistant: a spoken (WAV) or typed bus question; null if the server can't be reached.
// context: the trip in progress (current bus, where to get off), so "my bus" / "open the camera" make sense.
export interface AskContext {
  step: string;
  route: string;
  alight: string;
}

function askQuery(lat: number, lon: number, context: AskContext): string {
  return "lat=" + lat + "&lon=" + lon + "&step=" + encodeURIComponent(context.step) + "&route=" +
    encodeURIComponent(context.route) + "&alight=" + encodeURIComponent(context.alight);
}

export async function askByVoice(wav: Blob, lat: number, lon: number, context: AskContext): Promise<AskResponse | null> {
  try {
    const res = await fetch("/api/ask?" + askQuery(lat, lon, context), {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    return res.ok ? ((await res.json()) as AskResponse) : null;
  } catch {
    return null;
  }
}

export async function askByText(text: string, lat: number, lon: number, context: AskContext): Promise<AskResponse | null> {
  try {
    const res = await fetch("/api/ask?text=" + encodeURIComponent(text) + "&" + askQuery(lat, lon, context));
    return res.ok ? ((await res.json()) as AskResponse) : null;
  } catch {
    return null;
  }
}

// A free server function sleeps after a few idle minutes and takes seconds to start: wake it while the
// rider is still talking, so the question itself doesn't wait for the start-up.
export function wakeServer(): void {
  fetch("/api/health", { cache: "no-store" }).catch(function () {});
}

// What the server can do: a free host has no Whisper (speech is recognised in the browser) and no OCR.
export interface ServerCaps {
  stt: boolean;
  ocr: boolean;
}

export async function serverCaps(): Promise<ServerCaps> {
  try {
    const res = await fetch("/api/health");
    const body = (await res.json()) as { stt?: boolean; ocr?: boolean };
    return { stt: body.stt !== false, ocr: body.ocr !== false };
  } catch {
    return { stt: true, ocr: true };
  }
}

// Closest stop to a GPS position, so the rider hears and sees where the app thinks they are.
export async function nearestStop(lat: number, lon: number): Promise<NearestStop | null> {
  try {
    const res = await fetch("/api/stops/nearest?lat=" + lat + "&lon=" + lon);
    return res.ok ? ((await res.json()) as NearestStop) : null;
  } catch {
    return null;
  }
}

// Where the rider says they are (WAV) or types it. null = server unreachable or down.
export async function locateBySpeech(wav: Blob): Promise<VoiceLocateResponse | null> {
  try {
    const res = await fetch("/api/locate/voice", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    return res.ok ? ((await res.json()) as VoiceLocateResponse) : null;
  } catch {
    return null;
  }
}

export async function locateByText(text: string): Promise<VoiceLocateResponse | null> {
  try {
    const res = await fetch("/api/locate?text=" + encodeURIComponent(text));
    return res.ok ? ((await res.json()) as VoiceLocateResponse) : null;
  } catch {
    return null;
  }
}

// The phone read the sign itself (lib/ocr.ts, free hosting): the server only decides from the texts.
// The texts are tiny, so a slow cold start of a free server function is allowed a little longer.
export async function verifyTexts(texts: [string, number][], stopId: string, route: string): Promise<VerifyResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, VERIFY_TIMEOUT_MS * 3);
  try {
    const res = await fetch("/api/verify/texts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        texts: texts.map(function (item) {
          return { text: item[0], confidence: Math.min(1, Math.max(0, item[1])) };
        }),
        stop_id: stopId,
        wanted_route: route,
      }),
      signal: controller.signal,
    });
    return res.ok ? ((await res.json()) as VerifyResponse) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Never throws and never waits longer than VERIFY_TIMEOUT_MS. null = no answer in time, which says
// nothing about the sign, so it isn't a vote (the camera says "not sure" if answers stop coming).
export async function verifySign(req: VerifyRequest): Promise<VerifyResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    return res.ok ? ((await res.json()) as VerifyResponse) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
