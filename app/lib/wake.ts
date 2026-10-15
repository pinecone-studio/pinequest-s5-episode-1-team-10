// Keeps the screen on while it matters (camera looking for the bus, the ride): an iPhone auto-locks
// after 30 s - 1 min without a touch, and a locked phone pauses the page, so the camera and the
// "next stop" announcements would stop mid-trip. Screen Wake Lock API: iPhone (iOS 16.4+), Android.
// The browser drops the lock whenever the page is hidden; it's taken again when the page comes back.

interface Sentinel {
  release: () => Promise<void>;
  addEventListener: (type: "release", fn: () => void) => void;
}

let lock: Sentinel | null = null;
let wanted = false;
let asking = false;

function take(): void {
  const api = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<Sentinel> } }).wakeLock;
  if (!api || lock || asking || document.visibilityState !== "visible") {
    return;
  }
  asking = true;
  api
    .request("screen")
    .then(function (sentinel) {
      asking = false;
      if (!wanted) {
        sentinel.release().catch(function () {});
        return;
      }
      lock = sentinel;
      sentinel.addEventListener("release", function () {
        lock = null;
      });
    })
    .catch(function () {
      asking = false; // low battery mode or not allowed: the screen may lock
    });
}

export function keepScreenOn(on: boolean): void {
  wanted = on;
  if (on) {
    take();
  } else if (lock) {
    const l = lock;
    lock = null;
    l.release().catch(function () {});
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", function () {
    if (wanted) {
      take();
    }
  });
}
