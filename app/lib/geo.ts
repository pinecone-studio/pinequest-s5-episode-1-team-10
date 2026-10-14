// Small-distance geometry on the map: metres between two points, compass bearing from one to another.

export function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}

// Degrees clockwise from north, 0..360.
export function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * r);
  const y = bLat - aLat;
  return ((Math.atan2(x, y) / r) % 360 + 360) % 360;
}

// The point `distanceM` from (lat, lon) toward `deg` (for simulated walks).
export function offset(lat: number, lon: number, deg: number, distanceM: number): { lat: number; lon: number } {
  const r = Math.PI / 180;
  const dLat = (distanceM * Math.cos(deg * r)) / 6371000 / r;
  const dLon = (distanceM * Math.sin(deg * r)) / (6371000 * Math.cos(lat * r)) / r;
  return { lat: lat + dLat, lon: lon + dLon };
}

// target - heading, folded to -180..180 (+ = to the right).
export function relative(target: number, heading: number): number {
  return ((((target - heading) % 360) + 540) % 360) - 180;
}
