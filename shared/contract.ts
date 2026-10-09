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

// POST /plan. Errors: 404 { detail } = no suggestion (detail is Mongolian, speak it); 503 = bus data down.
export interface PlanRequest {
  text: string; // what the rider said, e.g. "Сансар руу явна"
  lat: number;
  lon: number;
}

export interface PlanStop {
  stop_id: string;
  name: string;
}

export interface BoardStop extends PlanStop {
  distance_m: number; // walk from the rider, straight line
  lat: number;
  lon: number;
}

export interface PlanResponse {
  route: string; // Hamuga busRouteNo to take, e.g. "Ч:75"; send as wanted_route to /verify
  board_stop: BoardStop; // send its stop_id to /verify
  destination: PlanStop; // the stop the rider named (as matched from what was heard)
  alight_stop: PlanStop; // where to get off: the named stop, or a neighbour within 500 m if no direct bus goes there
  stops_to_ride: number;
  routes_at_stop: string[]; // every busRouteNo serving board_stop
  speech: string[]; // Mongolian sentences to speak in order; fetch each from /tts
  found_speech: string; // Mongolian "this is your bus" sentence for when /verify says yes
}

// POST /locate/voice with a WAV body (or GET /locate?text=): the rider says where they are,
// when GPS is off or imprecise.
export interface LocatedStop {
  stop_id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface VoiceLocateResponse {
  heard: string; // what speech recognition heard ("" if nothing)
  stop: LocatedStop | null; // the stop the rider said they're at; use its lat/lon
  message: string | null; // Mongolian reason when stop is null; speak it
}

// POST /plan/voice?lat=&lon= with a WAV body (16 kHz mono): speech recognition + /plan in one call.
// 200 always (422 = bad audio, 503 = bus data down).
export interface VoicePlanResponse {
  heard: string; // what speech recognition heard ("" if nothing)
  plan: PlanResponse | null; // the bus to take; null if none
  message: string | null; // Mongolian reason when plan is null; speak it
}

// GET /ride?route=Ч:55&board=000000282&alight=000000204: the stops to ride, for on-bus announcements.
export interface RideStop {
  stop_id: string;
  name: string; // "" if Hamuga doesn't know the stop
  lat: number | null; // null if Hamuga has no coordinates; still counts as a stop
  lon: number | null;
  speech: string; // "Дараагийн зогсоол: ..." to say as this stop comes up ("" if unnamed)
}

export interface RideResponse {
  route: string;
  stops: RideStop[]; // boarding stop first, alighting stop last, in riding order
}

// GET /tts?text=... -> audio/wav (Mongolian, OronTTS). Fixed phrases: shared/phrases.json.
