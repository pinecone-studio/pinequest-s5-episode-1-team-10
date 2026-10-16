// Registers public/sw.js: the fixed voice clips are kept on the phone and play with no signal, and the
// installed (home screen) app opens offline: the start page, its code, manifest and icons are kept.
// Production build only (in `next dev` a worker would serve stale clips while we change them).
// ?nosw removes the worker and its clips (kill switch if a phone ever gets a bad one).

export function registerOffline(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  if (new URLSearchParams(window.location.search).has("nosw")) {
    navigator.serviceWorker.getRegistrations().then(function (list) {
      list.forEach(function (item) {
        item.unregister();
      });
    });
    caches.keys().then(function (keys) {
      keys.forEach(function (item) {
        if (item.startsWith("voice-") || item.startsWith("shell-")) {
          caches.delete(item);
        }
      });
    });
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  // After load, so the worker's clip downloads never compete with the app's first requests.
  function register(): void {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(function () {
        return navigator.serviceWorker.ready;
      })
      .then(function (registration) {
        // This page's code was loaded before the worker ran: tell it which files to keep (app shell).
        const urls = performance
          .getEntriesByType("resource")
          .map(function (item) {
            return item.name;
          })
          .filter(function (item) {
            return new URL(item).pathname.startsWith("/_next/static/");
          });
        if (registration.active && urls.length) {
          registration.active.postMessage({ type: "keep", urls: urls });
        }
      })
      .catch(function (e) {
        console.warn("voice clips not stored offline", e);
      });
  }
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}
