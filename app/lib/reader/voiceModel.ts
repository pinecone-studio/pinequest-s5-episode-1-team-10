// The reading voice, in the reader's worker: Meta MMS-TTS "mon" (VITS, CC-BY-NC-4.0, free for
// non-commercial use), exported to ONNX by deploy/reader_models.py.
//   voice_mn.onnx  the graph (1.4 MB); its weights are external data "<name>.weights"
//   voice_mn.pack  the weights, compressed 114 MB -> 35 MB: int8 per row for the decoder and flow,
//                  fp16 for the text encoder and durations (measured: no audible change)
// The fp32 weights are rebuilt here and handed to onnxruntime, so the model runs exactly as exported.
import type * as Ort from "onnxruntime-web";
import type { Gate } from "./pageOcr";
import { speechChunks } from "./speechText";

type OrtModule = typeof Ort;
export const VOICE_RATE = 16000;
export const VOICE_PRIORITY = 3; // before aiming and page reading: the rider is waiting to hear it

interface PackTensor {
  kind: "i8" | "f16";
  count: number; // values
  data: number; // byte offset in the pack's data section
  bytes: number;
  at: number; // byte offset in the rebuilt fp32 weights
  rows?: number; // i8: one scale per row
}

// IEEE half -> float, through a table (65536 entries).
let halfTable: Float32Array | null = null;
function halfToFloat(): Float32Array {
  if (halfTable) {
    return halfTable;
  }
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    t[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  halfTable = t;
  return t;
}

function rebuild(pack: Uint8Array): { name: string; weights: Uint8Array } {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (String.fromCharCode(pack[0], pack[1], pack[2], pack[3]) !== "WPK1") {
    throw new Error("not a weight pack");
  }
  const headerLength = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(pack.subarray(8, 8 + headerLength))) as { weights: string; size: number; tensors: PackTensor[] };
  const start = 8 + headerLength + ((4 - ((8 + headerLength) % 4)) % 4);
  const out = new Float32Array(header.size / 4);
  const half = halfToFloat();
  header.tensors.forEach(function (item) {
    const at = item.at / 4;
    const from = pack.byteOffset + start + item.data;
    if (item.kind === "f16") {
      const h = new Uint16Array(pack.buffer, from, item.count);
      for (let i = 0; i < item.count; i++) {
        out[at + i] = half[h[i]];
      }
    } else {
      const rows = item.rows as number;
      const cols = item.count / rows;
      const scale = new Float32Array(pack.buffer, from, rows);
      const q = new Int8Array(pack.buffer, from + rows * 4, item.count);
      for (let r = 0; r < rows; r++) {
        const s = scale[r];
        const o = at + r * cols;
        const qo = r * cols;
        for (let c = 0; c < cols; c++) {
          out[o + c] = q[qo + c] * s;
        }
      }
    }
  });
  return { name: header.weights, weights: new Uint8Array(out.buffer) };
}

// Finite, not silent, not clipped all over: what a working voice gives.
function soundAudio(a: Float32Array): boolean {
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (!Number.isFinite(v)) {
      return false;
    }
    peak = Math.max(peak, v);
    if (v > 0.999) {
      clipped++;
    }
  }
  return a.length > 1000 && peak > 0.02 && clipped < a.length * 0.01;
}

export class VoiceModel {
  private ort: OrtModule;
  private session: Ort.InferenceSession;
  private gate: Gate;
  backend: string;

  private constructor(ort: OrtModule, session: Ort.InferenceSession, gate: Gate, backend: string) {
    this.ort = ort;
    this.session = session;
    this.gate = gate;
    this.backend = backend;
  }

  // On the phone's GPU (WebGPU) where it has one: the sound decoder is ~95% of the work and runs
  // there (the random-noise steps fall back to the CPU by themselves); else on the CPU (WASM). The GPU
  // voice is checked on a warm-up sentence and dropped if it isn't sound audio.
  // The pack is read once into fp32 weights; onnxruntime copies them in, so the 114 MB copy here is
  // dropped as soon as the session that's kept has them (iPhones close tabs that hold too much).
  static async load(ort: OrtModule, graph: Uint8Array, pack: Uint8Array, gate: Gate, useGpu: boolean, step: (what: string) => void): Promise<VoiceModel> {
    const built: { name: string; weights: Uint8Array | null } = rebuild(pack);
    step("weights rebuilt");
    async function create(providers: string[]): Promise<Ort.InferenceSession> {
      const weights = built.weights as Uint8Array;
      return gate(VOICE_PRIORITY, function () {
        return ort.InferenceSession.create(graph, {
          executionProviders: providers,
          logSeverityLevel: 3,
          externalData: [{ path: built.name, data: weights }],
        });
      });
    }
    if (useGpu) {
      let session: Ort.InferenceSession | null = null;
      try {
        session = await create(["webgpu", "wasm"]);
        step("GPU session made");
        const gpu = new VoiceModel(ort, session, gate, "webgpu");
        const test = await gpu.say("Сайн байна уу.");
        step("GPU test sentence " + (test && soundAudio(test) ? "sound" : "broken"));
        if (test && soundAudio(test)) {
          built.weights = null;
          return gpu;
        }
      } catch (e) {
        console.warn("reading voice: no GPU", e);
      }
      if (session) {
        // its weights would otherwise stay in memory next to the CPU voice's
        await session.release().catch(function () {});
      }
    }
    const cpu = new VoiceModel(ort, await create(["wasm"]), gate, "wasm");
    built.weights = null;
    step("CPU session made");
    await cpu.say("Сайн байна уу."); // warm-up: the first run prepares its kernels
    return cpu;
  }

  // One sentence -> 16 kHz audio, a piece (between punctuation) at a time, each with its pause after
  // it, so the first words play while the rest is made. `urgent`: ahead of sentences made in advance.
  async speak(sentence: string, urgent: boolean, piece: (audio: Float32Array) => void): Promise<void> {
    for (const chunk of speechChunks(sentence)) {
      const ids = new BigInt64Array(chunk.ids.length);
      chunk.ids.forEach(function (item, i) {
        ids[i] = BigInt(item);
      });
      const session = this.session;
      const input = new this.ort.Tensor("int64", ids, [1, ids.length]);
      const out = await this.gate(urgent ? VOICE_PRIORITY + 1 : VOICE_PRIORITY, function () {
        return session.run({ [session.inputNames[0]]: input });
      });
      const wave = out[session.outputNames[0]].data as Float32Array;
      const audio = new Float32Array(wave.length + Math.round(chunk.pause * VOICE_RATE));
      audio.set(wave);
      piece(audio);
    }
  }

  // Whole sentence at once (the warm-up check).
  async say(sentence: string): Promise<Float32Array | null> {
    const parts: Float32Array[] = [];
    await this.speak(sentence, true, function (audio) {
      parts.push(audio);
    });
    let total = 0;
    parts.forEach(function (item) {
      total += item.length;
    });
    if (!total) {
      return null;
    }
    const out = new Float32Array(total);
    let at = 0;
    parts.forEach(function (item) {
      out.set(item, at);
      at += item.length;
    });
    return out;
  }
}
