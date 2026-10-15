// Keeps the screen on while the app is open: an iPhone auto-locks after 30 s - 1 min without a touch,
// a blind rider holds the phone and listens, and a locked phone pauses the page; Safari then drops a
// page that holds models and the app starts again from the beginning. Screen Wake Lock API: iPhone
// (iOS 16.4+), Android. The browser drops the lock whenever the page is hidden; it's taken again when
// the page comes back. What happens is logged ("[wake] ...", see lib/reader/remoteLog.ts).

interface Sentinel {
  release: () => Promise<void>;
  addEventListener: (type: "release", fn: () => void) => void;
}

let lock: Sentinel | null = null;
let wanted = false;
let asking = false;
let last = "not asked"; // what the phone said to the last request

// For the remote log's heartbeat: is the lock held right now, and why not.
export function wakeStatus(): string {
  return (lock ? "held" : wanted ? "wanted, not held (" + last + ")" : "not wanted") + (typeof navigator !== "undefined" && "wakeLock" in navigator ? "" : ", no API");
}

function take(): void {
  const api = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<Sentinel> } }).wakeLock;
  if (!api || lock || asking || document.visibilityState !== "visible") {
    if (!api) {
      last = "no API";
    }
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
      last = "granted";
      console.log("[wake] screen lock granted");
      sentinel.addEventListener("release", function () {
        lock = null;
        last = "released by the phone";
        console.log("[wake] screen lock released by the phone (" + document.visibilityState + ")");
      });
    })
    .catch(function (e: unknown) {
      asking = false; // not allowed without a touch (asked again on the next one), or low battery mode
      const why = "refused: " + (e instanceof Error ? e.name : "?");
      if (why !== last) {
        console.warn("[wake] screen lock " + why + (e instanceof Error ? " " + e.message : ""));
      }
      last = why;
    });
}

// Safari refuses the request when the page asks by itself with no touch, so it is asked again at the
// first touch of the rider (any), and every few seconds while it isn't held (a lock the phone dropped).
let armed = false;
function arm(): void {
  if (armed || typeof document === "undefined") {
    return;
  }
  armed = true;
  ["pointerdown", "touchend", "click", "keydown"].forEach(function (item) {
    document.addEventListener(
      item,
      function () {
        if (wanted) {
          take();
        }
      },
      true,
    );
  });
  setInterval(function () {
    if (wanted && !lock) {
      take();
    }
  }, 3000);
}

export function keepScreenOn(on: boolean): void {
  wanted = on;
  if (on) {
    arm();
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
