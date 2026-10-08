export interface Position {
  lat: number;
  lon: number;
}

// Rider's GPS position, or null if it's denied or unavailable.
export function locate(): Promise<Position | null> {
  return new Promise(function (resolve) {
    if (!("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      function () {
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}
