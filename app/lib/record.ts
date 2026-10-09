// Records one spoken destination as a 16 kHz mono WAV, stopping by itself shortly after the
// rider stops talking, so the answer comes as fast as possible.

const RATE = 16000;
const END_SILENCE_MS = 700; // this much quiet after speech ends the recording
const NO_SPEECH_MS = 5000; // give up if nothing is said
const MAX_MS = 8000;
const NOISE_MS = 250; // first part measures background noise

export interface Recording {
  done: Promise<Blob | null>; // WAV, or null if nothing was said / no microphone
  stop: () => void; // end now (rider tapped again)
  noMic: () => boolean; // true if the microphone was denied or missing
}

function toWav(samples: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  function text(offset: number, s: string): void {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  }
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

function rms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) {
    sum += block[i] * block[i];
  }
  return Math.sqrt(sum / block.length);
}

export function record(): Recording {
  let stopNow: () => void = function () {};
  let micDenied = false;
  const done = new Promise<Blob | null>(function (resolve) {
    let finished = false;
    let started = false;
    stopNow = function () {
      finished = true;
      if (!started) {
        resolve(null); // stopped before the microphone came on (e.g. still asking permission)
      }
    };
    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(async function (stream) {
        if (finished) {
          stream.getTracks().forEach(function (item) {
            item.stop();
          });
          return;
        }
        started = true;
        const ctx = new AudioContext({ sampleRate: RATE });
        await ctx.audioWorklet.addModule("/recorder-worklet.js");
        const source = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, "recorder");
        const mute = ctx.createGain();
        mute.gain.value = 0; // keeps the graph running without playing the mic back
        source.connect(node);
        node.connect(mute);
        mute.connect(ctx.destination);

        const blocks: Float32Array[] = [];
        let elapsed = 0;
        let noise = 0;
        let spoke = false;
        let quietMs = 0;

        function finish(): void {
          node.port.onmessage = null;
          stream.getTracks().forEach(function (item) {
            item.stop();
          });
          ctx.close();
          const total = blocks.reduce(function (n, item) {
            return n + item.length;
          }, 0);
          const all = new Float32Array(total);
          let at = 0;
          blocks.forEach(function (item) {
            all.set(item, at);
            at += item.length;
          });
          resolve(spoke ? toWav(all) : null);
        }

        node.port.onmessage = function (e: MessageEvent<Float32Array>) {
          const block = e.data;
          const ms = (block.length / RATE) * 1000;
          elapsed += ms;
          blocks.push(block);
          const level = rms(block);
          if (elapsed <= NOISE_MS) {
            noise = Math.max(noise, level);
          } else if (level > Math.max(0.015, noise * 3)) {
            spoke = true;
            quietMs = 0;
          } else if (spoke) {
            quietMs += ms;
          }
          const silentEnd = spoke && quietMs >= END_SILENCE_MS;
          const nothing = !spoke && elapsed >= NO_SPEECH_MS;
          if (finished || silentEnd || nothing || elapsed >= MAX_MS) {
            finish();
          }
        };
      })
      .catch(function () {
        micDenied = true;
        resolve(null);
      });
  });
  return {
    done,
    stop: function () {
      stopNow();
    },
    noMic: function () {
      return micDenied;
    },
  };
}

// Short beep: "speak now". Played before recording so it isn't recorded.
export function beep(): Promise<void> {
  return new Promise(function (resolve) {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = function () {
      ctx.close();
      resolve();
    };
  });
}
