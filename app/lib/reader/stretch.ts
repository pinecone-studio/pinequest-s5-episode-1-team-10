// Faster (or slower) speech with the pitch kept: WSOLA (overlap-add of short windows, each one moved a
// little to where it lines up best with the last, so the voice doesn't buzz). Blind readers often
// listen at 1.5-2x. Done here because the reading voice plays through Web Audio (gapless), where a
// faster playback rate would also raise the pitch.
const WINDOW = 640; // 40 ms at 16 kHz
const HOP = WINDOW / 2;
const SEEK = 160; // +-10 ms searched for the best fit

let hann: Float32Array | null = null;
function hannWindow(): Float32Array {
  if (!hann) {
    hann = new Float32Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) {
      hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
    }
  }
  return hann;
}

export function stretch(input: Float32Array, speed: number): Float32Array {
  if (Math.abs(speed - 1) < 0.01 || input.length < WINDOW * 2) {
    return input;
  }
  const w = hannWindow();
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
