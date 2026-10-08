// Data contract between the phone app and the server. Mirror: server/contract.py.
// If the server doesn't answer within 1 second, the app says "Not sure, please check."

export type Verdict = "yes" | "no" | "unsure";

export interface VerifyRequest {
  sign_crop: string; // base64 JPEG of the route-sign crop
  stop_id: string; // Hamuga busStopId, e.g. "000000529"
  wanted_route: string; // Hamuga busRouteNo, e.g. "Ч:81"
}

export interface VerifyResponse {
  verdict: Verdict;
  confidence: number; // 0..1
  eta_seconds: number | null; // wanted bus ETA at this stop; null if unknown
}

export interface NearestStop {
  stop_id: string; // Hamuga busStopId, e.g. "000000529"
  name: string;
  distance_m: number; // meters from the given point
  routes: string[]; // Hamuga busRouteNo values serving this stop, e.g. "Ч:81"
}

export const VERIFY_TIMEOUT_MS = 1000;
