// ?log=1: the reader's console lines and errors are sent to `/__log`, one request per line, so a
// phone with no developer tools (an iPhone away from a Mac) still shows what happened, up to the
// moment a tab is closed for using too much memory. Only for testing; nothing listens on a deploy.
let started = false;

function send(level: string, parts: unknown[]): void {
  const text = parts
    .map(function (item) {
      if (item instanceof Error) {
        return item.name + ": " + item.message;
      }
      return typeof item === "string" ? item : JSON.stringify(item);
    })
    .join(" ");
  fetch("/__log", {
    method: "POST",
    body: Math.round(performance.now()) + " ms " + level + " " + text,
    keepalive: true,
  }).catch(function () {});
}

export function startRemoteLog(): void {
  if (started || new URLSearchParams(window.location.search).get("log") !== "1") {
    return;
  }
  started = true;
  (["log", "warn", "error"] as const).forEach(function (item) {
    const original = console[item].bind(console);
    console[item] = function (...args: unknown[]) {
      original(...args);
      send(item, args);
    };
  });
  window.addEventListener("error", function (e) {
    send("error", [e.message + " at " + e.filename + ":" + e.lineno]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    send("error", ["unhandled", e.reason]);
  });
  // Why the page started again: the phone closing it for memory shows as a reload / discarded page.
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  send("info", [
    "navigation " + (nav ? nav.type : "?"),
    "wasDiscarded " + String((document as unknown as { wasDiscarded?: boolean }).wasDiscarded),
  ]);
  ["pagehide", "freeze", "resume", "pageshow"].forEach(function (item) {
    window.addEventListener(item, function () {
      send("info", ["event " + item + " " + document.visibilityState]);
    });
  });
  document.addEventListener("visibilitychange", function () {
    send("info", ["visibility " + document.visibilityState]);
  });
  const n = navigator as unknown as { gpu?: unknown; audioSession?: unknown; wakeLock?: unknown; deviceMemory?: number };
  send("info", [
    "start " + navigator.userAgent,
    "url " + window.location.protocol + "//" + window.location.host,
    "secure " + String(window.isSecureContext),
    "mediaDevices " + String(Boolean(navigator.mediaDevices)),
    "cores " + navigator.hardwareConcurrency,
    "isolated " + String(window.crossOriginIsolated),
    "gpu " + String("gpu" in navigator),
    "audioSession " + String(Boolean(n.audioSession)),
    "wakeLock " + String(Boolean(n.wakeLock)),
    "screen " + window.screen.width + "x" + window.screen.height + "@" + window.devicePixelRatio,
  ]);
}
