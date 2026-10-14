// Which way the phone's back camera faces, in degrees clockwise from north, for walking guidance.
// Android Chrome: "deviceorientationabsolute" (alpha/beta/gamma against magnetic north).
// iPhone: "deviceorientation" with webkitCompassHeading, after a permission asked inside a tap.

interface IosOrientationEvent {
  requestPermission?: () => Promise<string>;
}

// Call inside a tap (iPhone shows its permission prompt only then). Resolves false if refused.
export function requestCompassPermission(): Promise<boolean> {
  const D = (typeof DeviceOrientationEvent === "undefined" ? null : DeviceOrientationEvent) as unknown as IosOrientationEvent | null;
  if (D && typeof D.requestPermission === "function") {
    return D.requestPermission()
      .then(function (result) {
        return result === "granted";
      })
      .catch(function () {
        return false;
      });
  }
  return Promise.resolve(true);
}

// Heading of the back camera from the W3C Euler angles (device frame -> earth frame, Z-X'-Y'').
// A phone lying flat has its camera facing the ground: then the direction its top points is used.
export function cameraHeading(alpha: number, beta: number, gamma: number): number {
  const r = Math.PI / 180;
  const cA = Math.cos(alpha * r);
  const sA = Math.sin(alpha * r);
  const cB = Math.cos(beta * r);
  const sB = Math.sin(beta * r);
  const cG = Math.cos(gamma * r);
  const sG = Math.sin(gamma * r);
  // R * (0, 0, -1): east, north, up components of the camera direction.
  const east = -cA * sG - sA * sB * cG;
  const north = -sA * sG + cA * sB * cG;
  const up = -cB * cG;
  const deg = Math.abs(up) > 0.8 ? 360 - alpha : Math.atan2(east, north) / r;
  return ((deg % 360) + 360) % 360;
}

// Calls back with each new heading; returns a function that stops listening.
export function watchCompass(listener: (heading: number) => void): () => void {
  function onAbsolute(e: Event): void {
    const o = e as DeviceOrientationEvent;
    if (o.alpha !== null && o.beta !== null && o.gamma !== null) {
      listener(cameraHeading(o.alpha, o.beta, o.gamma));
    }
  }
  function onOrientation(e: Event): void {
    const ios = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
    if (typeof ios === "number" && !Number.isNaN(ios)) {
      listener(ios);
    }
    // Android's plain "deviceorientation" is relative to where the page started: not a compass.
  }
  window.addEventListener("deviceorientationabsolute", onAbsolute);
  window.addEventListener("deviceorientation", onOrientation);
  return function () {
    window.removeEventListener("deviceorientationabsolute", onAbsolute);
    window.removeEventListener("deviceorientation", onOrientation);
  };
}
