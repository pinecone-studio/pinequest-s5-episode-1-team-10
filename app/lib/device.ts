// iPhone / iPad (every browser there is Safari underneath). Safari reloads a page that uses too much
// memory, so the camera runs lighter there (lib/detector.ts, BusCamera, lib/doorDetector.ts).
export function isIOS(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
