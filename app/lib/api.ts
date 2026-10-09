// Calls to the FastAPI server, proxied under /api (next.config.ts).
import type {
  NearestStop,
  PlanResponse,
  VerifyRequest,
  VerifyResponse,
  VoiceLocateResponse,
  VoicePlanResponse,
} from "../../shared/contract";
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
