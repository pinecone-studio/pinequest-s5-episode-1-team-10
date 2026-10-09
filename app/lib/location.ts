export interface Position {
  lat: number;
  lon: number;
  accuracy: number; // meters, 95% radius as reported by the browser (0 = said by the rider)
}

// A laptop's Wi-Fi location can be off by a kilometre; a phone outdoors is 5-30 m.
export const GPS_OK_M = 150;

// Rider's GPS position, or null if it's denied or unavailable.
export function locate(): Promise<Position | null> {
  return new Promise(function (resolve) {
    if (!("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
      function () {
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}
