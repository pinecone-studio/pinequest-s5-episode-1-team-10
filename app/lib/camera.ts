// Which back camera to open. The bus scanner wants the widest one (the whole bus fits in the frame up
// close); the book reader wants the main one (an ultra-wide distorts a page up close and focuses
// badly, and iPhone's virtual "Dual"/"Triple" cameras switch to the ultra-wide for close-ups).
// Device labels are only filled in once the camera is allowed, so each opener asks for the default
// back camera first and then switches.
import { MAIN_FOV_DEG, ULTRA_WIDE_FOV_DEG } from "./door";

export interface CameraDevice {
  kind: string;
  label: string;
  deviceId: string;
}

// "default": the browser's own back camera; "ultrawide-label": a camera labelled "Ultra Wide"
// (iPhone); "ultrawide-zoom": zoomed out below 1x (Android).
export type BusCameraChoice = "default" | "ultrawide-label" | "ultrawide-zoom";

export interface BusCameraStream {
  stream: MediaStream;
  choice: BusCameraChoice;
  label: string;
  fovDeg: number; // across the long side, for the door guidance (lib/door.ts)
}

const FRONT = /front/i;
const ULTRA_WIDE = /ultra ?wide/i;
// Never for reading: the ultra-wide, the telephoto, and iPhone's virtual multi-lens cameras.
const NOT_FOR_READING = /front|ultra ?wide|telephoto|dual|triple/i;
const BACK = /back|rear|environment/i;

function cameras(devices: CameraDevice[]): CameraDevice[] {
  return devices.filter(function (item) {
    return item.kind === "videoinput";
  });
}

// iPhone labels its ultra-wide "Back Ultra Wide Camera" (in the phone's language: a Russian iPhone
// doesn't match and keeps the default camera, which is safe).
export function pickUltraWide(devices: CameraDevice[]): CameraDevice | null {
  const found = cameras(devices).find(function (item) {
    return ULTRA_WIDE.test(item.label) && !FRONT.test(item.label);
  });
  return found ?? null;
}

// Android: the main camera zooms out below 1x when the phone can switch to its ultra-wide.
export function wideZoom(caps: { zoom?: { min?: number } } | null | undefined): number | null {
  const min = caps && caps.zoom ? caps.zoom.min : undefined;
  return typeof min === "number" && min > 0 && min < 1 ? min : null;
}

// Field of view of the main camera zoomed to `zoom` (0.5 -> ~104 deg).
export function fovForZoom(zoom: number): number {
  return (2 * Math.atan(Math.tan(((MAIN_FOV_DEG / 2) * Math.PI) / 180) / zoom) * 180) / Math.PI;
}

export function badForReading(label: string): boolean {
  return NOT_FOR_READING.test(label);
}

// The plain main back camera: iPhone's "Back Camera", else the first back camera that is not an
// ultra-wide, telephoto or multi-lens one (Android lists the main one first: "camera2 0, facing back").
// null: no label says so (labels hidden, another language, a laptop): keep the browser's choice.
export function pickMainBack(devices: CameraDevice[]): CameraDevice | null {
  const usable = cameras(devices).filter(function (item) {
    return BACK.test(item.label) && !badForReading(item.label);
  });
  const exact = usable.find(function (item) {
    return /^back camera$/i.test(item.label.trim());
  });
  return exact ?? usable[0] ?? null;
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach(function (item) {
    item.stop();
  });
}

async function listCameras(): Promise<CameraDevice[]> {
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

function trackOf(stream: MediaStream): MediaStreamTrack | null {
  return stream.getVideoTracks()[0] ?? null;
}

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

// Opens `exact` instead of `current` (stopped first: a phone opens one back camera at a time). If the
// switch fails the default back camera is opened again; null if even that fails.
async function switchTo(current: MediaStream, exact: CameraDevice, size: MediaTrackConstraints): Promise<{ stream: MediaStream; switched: boolean }> {
  stopStream(current);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...size, deviceId: { exact: exact.deviceId } }, audio: false });
    return { stream, switched: true };
  } catch {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: "environment" }, audio: false });
    return { stream, switched: false };
  }
}

// The bus scanner's camera: the ultra-wide where there is one, else the default back camera.
// `size`: the resolution wanted. `main`: keep the default back camera (?cam=main).
export async function openBusCamera(size: MediaTrackConstraints, main?: boolean): Promise<BusCameraStream> {
  const base: MediaTrackConstraints = { ...size, facingMode: "environment" };
  let stream: MediaStream;
  if (isAndroid() && !main) {
    // Chrome may only report the zoom range when zoom was asked for (to check on a phone).
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, zoom: true } as MediaTrackConstraints, audio: false });
    } catch (e) {
      if (e instanceof Error && e.name === "NotAllowedError") {
        throw e;
      }
      stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
    }
  } else {
    stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
  }
  let choice: BusCameraChoice = "default";
  let fovDeg = MAIN_FOV_DEG;
  if (!main) {
    const track = trackOf(stream);
    const wide = pickUltraWide(await listCameras());
    if (wide && track && track.label === wide.label) {
      choice = "ultrawide-label";
    } else if (wide) {
      const next = await switchTo(stream, wide, size);
      stream = next.stream;
      choice = next.switched ? "ultrawide-label" : "default";
    } else if (track && track.getCapabilities) {
      const zoom = wideZoom(track.getCapabilities() as { zoom?: { min?: number } });
      if (zoom !== null) {
        try {
          await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
          choice = "ultrawide-zoom";
          fovDeg = fovForZoom(zoom);
        } catch {
          // the phone refused: stay at 1x
        }
      }
    }
    if (choice === "ultrawide-label") {
      fovDeg = ULTRA_WIDE_FOV_DEG;
    }
  }
  const track = trackOf(stream);
  const label = track ? track.label : "";
  console.info("[camera] bus:", choice, label);
  return { stream, choice, label, fovDeg };
}

// The reader's camera: if the browser opened an ultra-wide, telephoto or multi-lens camera, the main
// back camera instead (same `size`). `stream` was opened with facingMode "environment".
export async function mainBackStream(stream: MediaStream, size: MediaTrackConstraints): Promise<{ stream: MediaStream; label: string }> {
  let track = trackOf(stream);
  let result = stream;
  if (track && badForReading(track.label)) {
    const main = pickMainBack(await listCameras());
    if (main) {
      result = (await switchTo(stream, main, size)).stream;
      track = trackOf(result);
    }
  }
  const label = track ? track.label : "";
  console.info("[camera] reader:", label);
  return { stream: result, label };
}
