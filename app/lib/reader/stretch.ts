// Faster (or slower) speech with the pitch kept: WSOLA (overlap-add of short windows, each one moved a
// little to where it lines up best with the last, so the voice doesn't buzz). Blind readers often
// listen at 1.5-2x. Done here because the reading voice plays through Web Audio (gapless), where a
// faster playback rate would also raise the pitch.
// Window 40 ms, half overlapping; +-10 ms searched for the best fit (16 kHz phone voice, 44.1 kHz cloud).
const hanns = new Map<number, Float32Array>();
function hannWindow(n: number): Float32Array {
  let hann = hanns.get(n);
  if (!hann) {
    hann = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    }
    hanns.set(n, hann);
  }
  return hann;
}

export function stretch(input: Float32Array, speed: number, rate = 16000): Float32Array {
  const WINDOW = 2 * Math.round(rate * 0.02);
  const HOP = WINDOW / 2;
  const SEEK = Math.round(rate * 0.01);
  if (Math.abs(speed - 1) < 0.01 || input.length < WINDOW * 2) {
    return input;
  }
  const w = hannWindow(WINDOW);
  const outLength = Math.floor(input.length / speed);
  const out = new Float32Array(outLength + WINDOW);
  let prev = 0; // where the last window was taken from
  for (let at = 0; at + WINDOW < outLength; at += HOP) {
    const ideal = Math.round(at * speed);
    let from = Math.min(ideal, input.length - WINDOW);
    if (at > 0) {
      // The natural continuation of the last window, matched within +-SEEK around the ideal spot.
      const follow = prev + HOP;
      let best = -Infinity;
      const lo = Math.max(0, ideal - SEEK);
      const hi = Math.min(input.length - WINDOW, ideal + SEEK);
      for (let c = lo; c <= hi; c += 2) {
        let score = 0;
        for (let k = 0; k < HOP; k += 4) {
          score += input[c + k] * (follow + k < input.length ? input[follow + k] : 0);
        }
        if (score > best) {
          best = score;
          from = c;
        }
      }
    }
    for (let k = 0; k < WINDOW; k++) {
      out[at + k] += input[from + k] * w[k];
    }
    prev = from;
  }
  return out.subarray(0, outLength);
}
