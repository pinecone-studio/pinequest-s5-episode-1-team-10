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

// GET /stops/{id}/routes: cached at the plan step so sign reads are decided on the phone.
export interface StopRoutes {
  routes: string[]; // busRouteNo values serving this stop
  city_numbers: string[]; // every route number in the city, so an LED "Ч55" read as "455" is not a guess
}

export interface NearestStop {
  stop_id: string; // Hamuga busStopId, e.g. "000000529"
  name: string;
  distance_m: number; // meters from the given point
  routes: string[]; // Hamuga busRouteNo values serving this stop, e.g. "Ч:81"
}

export const VERIFY_TIMEOUT_MS = 1000;

// POST /api/read-sign (Next.js route, Azure AI Vision Read; no Python mirror): body = raw image/jpeg of a
// sign crop. Only the phone decides (lib/parse-sign.ts, with the stop's routes).
// Errors: 429 = free-tier limit (Retry-After seconds), 503 = no Azure key, 502 = Azure failed.
export interface ReadSignResponse {
  lines: string[]; // text lines; an unsure word: "?" (1-2 characters, may be a route letter) or "…"
  azureMs: number; // the Azure call alone
  serverMs: number; // the whole request on the server (the rest of the phone's wait is the network)
}

// POST /plan. Errors: 404 { detail } = no suggestion (detail is Mongolian, speak it); 503 = bus data down.
export interface PlanRequest {
  text: string; // a place ("Сансар руу явна") or a bus number ("55", "Ч:55", "55-р автобус")
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

// The second bus of a two-bus trip (дамжин суух).
export interface Transfer {
  route: string; // send as wanted_route to /verify at board_stop
  board_stop: BoardStop; // distance_m = walk from where bus 1 drops you (0 = same stop)
  alight_stop: PlanStop; // the destination
  stops_to_ride: number;
  found_speech: string;
  speech: string[]; // said at the transfer stop: walk (if any), which bus, stops, where to get off
}

export interface PlanResponse {
  route: string; // Hamuga busRouteNo to take, e.g. "Ч:75"; send as wanted_route to /verify
  board_stop: BoardStop; // send its stop_id to /verify
  destination: PlanStop; // the stop the rider named; for a bus number, the last stop of the riding direction
  alight_stop: PlanStop; // where to get off: the named stop, a neighbour within 500 m, or (bus number) the last stop of the riding direction
  stops_to_ride: number;
  routes_at_stop: string[]; // every busRouteNo serving board_stop
  speech: string[]; // Mongolian pieces to speak in order (all pre-recordable); fetch each from /tts
  found_speech: string; // Mongolian "this is your bus" sentence for when /verify says yes
  transfer: Transfer | null; // two-bus trip: route/alight_stop/stops_to_ride above are the FIRST bus
  sure?: boolean; // false: the destination is a sound-alike of what was heard: ask "is it <destination>?" first
  alternatives?: string[]; // when not sure: other stop names that sound like what was heard
}

// Voice assistant. POST /ask?lat=&lon= with a WAV body, or GET /ask?text=&lat=&lon=. Answers come only
// from our bus data; anything else is "Мэдэхгүй байна".
export interface AskResponse {
  heard: string; // the question as heard ("" if nothing was heard)
  answer: string; // whole answer, for the screen
  speech: string[]; // Mongolian sentences to speak in order; fetch each from /tts
  action: AskAction | null; // what the app should do (speak `speech` too)
  plan: PlanResponse | null; // the trip, when action is "plan"
  clips?: (string | null)[]; // pre-made clip name per speech sentence: play /tts/<name>.mp3 directly; null/missing = use /tts
}
export type AskAction =
  | "plan"
  | "open_camera"
  | "door"
  | "stops_left"
  | "boarded"
  | "got_off"
  | "repeat_route"
  | "start_over"
  | "tutorial"
  | "sos" // text the family: SMS app opens prefilled (speech[1:] = where the rider is)
  | "call_family";

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
  speech: string[]; // ["Дараагийн зогсоол:", "МУБИС.", "Зүүн тал."] to say as this stop comes up ([] if unnamed)
}

export interface RideResponse {
  route: string;
  stops: RideStop[]; // boarding stop first, alighting stop last, in riding order
}

// GET /tts?text=... -> audio/wav (Mongolian, OronTTS). Fixed phrases: shared/phrases.json.
