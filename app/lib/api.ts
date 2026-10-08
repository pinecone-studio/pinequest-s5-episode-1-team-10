// Calls to the FastAPI server, proxied under /api (next.config.ts).
import type { PlanResponse, VerifyRequest, VerifyResponse, VoicePlanResponse } from "../../shared/contract";
import { VERIFY_TIMEOUT_MS } from "../../shared/contract";

export type PlanResult = { ok: true; plan: PlanResponse } | { ok: false; message: string };

const UNSURE: VerifyResponse = { verdict: "unsure", confidence: 0, eta_seconds: null };

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

// Never throws and never waits longer than VERIFY_TIMEOUT_MS: no answer means "unsure".
export async function verifySign(req: VerifyRequest): Promise<VerifyResponse> {
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
    return res.ok ? ((await res.json()) as VerifyResponse) : UNSURE;
  } catch {
    return UNSURE;
  } finally {
    clearTimeout(timer);
  }
}
