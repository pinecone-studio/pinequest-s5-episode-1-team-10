// Reads the route sign on the phone (free hosting has no OCR server): PaddleOCR PP-OCRv4 mobile models
// in ONNX (from RapidOCR, Apache-2.0), run with the same onnxruntime as the bus detector.
//   1. text detection (DB): probability map at SIGN_H px high -> connected regions -> boxes
//   2. text recognition (CTC) on each box -> text + confidence
// Ported 1:1 from a NumPy prototype checked on tov_nomyn_san_{1,2}.png: photo 1 reads
// "455 H 1000-E" (0.91), photo 2 has no route number -- the same verdicts as the server's PaddleOCR.
// Channels go in BGR order, like the OpenCV images the models were trained on.
import type * as Ort from "onnxruntime-web";
import { exclusive, modelBytes, runtime } from "./detector";
import { recognize } from "./ocrPixels";

// int8 copies (server/quantize_models.py): 15.6 -> 4.5 MB to download and in memory, same reads on the
// test photos (checked again in Chrome and WebKit before switching).
const DET_URL = "/models/ocr_det_int8.onnx";
const REC_URL = "/models/ocr_rec_int8.onnx";
const KEYS_URL = "/models/ocr_keys.txt";
const REC_H = 48;

let det: Ort.InferenceSession | null = null;
let rec: Ort.InferenceSession | null = null;
let keys: string[] = [];
let loading: Promise<boolean> | null = null;

// Loads once (15 MB); resolves false if it can't (then the camera just says "not sure").
export function loadOcr(): Promise<boolean> {
  if (!loading) {
    loading = (async function () {
      const [rt, detBytes, recBytes, text] = await Promise.all([
        runtime(),
        modelBytes(DET_URL),
        modelBytes(REC_URL),
        fetch(KEYS_URL).then(function (item) {
          return item.text();
        }),
      ]);
      // \r?\n: a Windows checkout (git autocrlf) turns the file into CRLF, and a "\r" glued to every
      // character made "455" arrive as "4\r5\r5\r" -> never a route number, never "yes".
      keys = ["blank"].concat(text.split(/\r?\n/), [" "]);
      det = await exclusive(function () {
        return rt.ort.InferenceSession.create(detBytes, { executionProviders: rt.providers });
      });
      rec = await exclusive(function () {
        return rt.ort.InferenceSession.create(recBytes, { executionProviders: rt.providers });
      });
      // One dummy detection, so the first real sign doesn't pay for shader / wasm compile.
      const warm = det;
      try {
        await exclusive(function () {
          return warm.run({
            [warm.inputNames[0]]: new rt.ort.Tensor("float32", new Float32Array(3 * 32 * 320), [1, 3, 320, 32]),
          });
        });
      } catch (e) {
        console.warn("sign reader warmup skipped", e);
      }
      return true;
    })().catch(function (e) {
      loading = null;
      console.warn("sign reading not available", e);
      return false;
    });
  }
  return loading;
}

// [(text, confidence)] read on the sign crop; [] if the models aren't loaded.
export async function readSign(crop: HTMLCanvasElement): Promise<[string, number][]> {
  if (!(await loadOcr()) || !det || !rec) {
    return [];
  }
  const { ort } = await runtime();
  const ctx = crop.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const px = ctx.getImageData(0, 0, crop.width, crop.height).data;
  const d = det;
  const r = rec;
  return recognize(px, crop.width, crop.height, {
    keys: keys,
    detect: function (data, height, width) {
      return exclusive(function () {
        return d.run({ [d.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, height, width]) });
      }).then(function (out) {
        return out[d.outputNames[0]].data as Float32Array;
      });
    },
    recognise: function (data, width) {
      return exclusive(function () {
        return r.run({ [r.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, REC_H, width]) });
      }).then(function (out) {
        const tensor = out[r.outputNames[0]];
        return { steps: tensor.dims[1] as number, classes: tensor.dims[2] as number, data: tensor.data as Float32Array };
      });
    },
  });
}
