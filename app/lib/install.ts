// Installing the app on the home screen, only when the rider asks (components/InstallButton.tsx).
// No popups: Chrome's own mini-infobar is held back and its dialog opens only from our button.
//   "installed"  already on the home screen (opened from it): nothing to show
//   "android"    Chrome offered an install (beforeinstallprompt): the button opens its dialog
//   "ios"        iPhone/iPad Safari: no install dialog exists, the button says the steps (not in-app views)
//   "none"       nothing to offer (desktop Safari, Firefox, Chrome before it offers, server render)

export type InstallState = "installed" | "android" | "ios" | "none";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let offered: InstallPromptEvent | null = null;
let justInstalled = false;
const listeners = new Set<() => void>();

function changed(): void {
  listeners.forEach(function (item) {
    item();
  });
}

// At import, not in an effect: Chrome may offer the install before React has hydrated.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); // no mini-infobar: only our button opens the dialog
    offered = e as InstallPromptEvent;
    changed();
  });
  window.addEventListener("appinstalled", function () {
    offered = null;
    justInstalled = true;
    changed();
  });
}

function standalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// iPhone, iPod, iPad (an iPad says "Macintosh" but has touch), in a browser with "Add to Home Screen"
// in its Share menu: Safari (Chrome/Edge/Firefox on iOS 16.4+ also say "Safari/"). In-app views
// (Facebook, Instagram, ...) don't say "Safari/" and have no way to install: no button there.
function iosDevice(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && /Safari\//.test(ua) && !/FBAN|FBAV|Instagram|Line\/|GSA\//.test(ua);
}

export function installState(): InstallState {
  if (justInstalled || standalone()) {
    return "installed";
  }
  if (offered) {
    return "android";
  }
  return iosDevice() ? "ios" : "none";
}

export function serverInstallState(): InstallState {
  return "none"; // the server can't know: the button appears after hydration
}

export function subscribeInstall(callback: () => void): () => void {
  listeners.add(callback);
  const mode = window.matchMedia("(display-mode: standalone)");
  mode.addEventListener("change", callback);
  return function () {
    listeners.delete(callback);
    mode.removeEventListener("change", callback);
  };
}

// Inside the button's click: Chrome's own install dialog. One prompt per offer.
export function openInstallDialog(): Promise<void> {
  const e = offered;
  if (!e) {
    return Promise.resolve();
  }
  offered = null;
  changed();
  return e
    .prompt()
    .then(function () {
      return e.userChoice;
    })
    .then(function () {})
    .catch(function () {});
}
