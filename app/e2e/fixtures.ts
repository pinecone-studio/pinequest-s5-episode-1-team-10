// Shared e2e setup: paid services answered here (never called), a camera for WebKit, and a guard that
// fails the test on any console error, page error, failed request or HTTP error (NIGHT_PLAN item 7).
import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import phrases from "../../shared/phrases.json";

const PHRASES = phrases as Record<string, string>;
const FIXTURES = "e2e/fixtures/";

// The app's own wording (shared/phrases.json), so a test follows the labels the rider hears.
export function phrase(key: string): string {
  const text = PHRASES[key];
  if (!text) {
    throw new Error("no phrase " + key);
  }
  return text;
}

// What the mocked page OCR (/api/reader/ocr, Gemini on the server) "read": existing app sentences, so
// the test needs no wording of its own.
export const PAGE_LINES = [phrase("searching"), phrase("location_ok")];

// 0.2 s of silence (WAV): the mocked reader voice (/api/reader/voice, ElevenLabs); decodeAudioData
// takes it whatever the content type says.
function silentWav(): Buffer {
  const samples = 3200;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

// Runs in the page (WebKit, or any page told to show the reader's page): getUserMedia gives a canvas
// stream of a fixture image, and the cameras are listed like an iPhone 13 Pro's, so the bus camera's
// "Ultra Wide" choice (lib/camera.ts) is exercised.
function cameraStandIn(src: string): void {
  const devices = [
    { deviceId: "e2e-back", label: "Back Camera" },
    { deviceId: "e2e-ultra", label: "Back Ultra Wide Camera" },
  ];
  let granted = false;
  // On the prototype: WebKit may hand out a new navigator.mediaDevices wrapper, dropping own properties
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
  }
  const media = (typeof MediaDevices === "function" ? MediaDevices.prototype : navigator.mediaDevices) as MediaDevices;
  media.enumerateDevices = function () {
    return Promise.resolve(
      devices.map(function (item) {
        const info = { deviceId: item.deviceId, groupId: "e2e", kind: "videoinput", label: granted ? item.label : "" };
        return Object.assign(info, {
          toJSON: function () {
            return info;
          },
        }) as unknown as MediaDeviceInfo;
      }),
    );
  };
  media.getUserMedia = async function (constraints?: MediaStreamConstraints): Promise<MediaStream> {
    if (!constraints || !constraints.video) {
      // Microphone: silence
      const ctx = new AudioContext();
      return ctx.createMediaStreamDestination().stream;
    }
    granted = true;
    const wanted = typeof constraints.video === "object" ? constraints.video.deviceId : undefined;
    const id = typeof wanted === "string" ? wanted : wanted && typeof wanted === "object" && "exact" in wanted ? String(wanted.exact) : "e2e-back";
    const device =
      devices.find(function (item) {
        return item.deviceId === id;
      }) ?? devices[0];
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const draw = function (): void {
      ctx.drawImage(img, 0, 0);
    };
    draw();
    const timer = setInterval(draw, 100); // captureStream sends a frame only when the canvas changes
    const stream = canvas.captureStream(15);
    const track = stream.getVideoTracks()[0];
    const settings = { deviceId: device.deviceId, width: canvas.width, height: canvas.height, frameRate: 15, facingMode: "environment" };
    Object.defineProperty(track, "label", { value: device.label });
    track.getSettings = function () {
      return settings as MediaTrackSettings;
    };
    track.getCapabilities = function () {
      return { deviceId: device.deviceId, facingMode: ["environment"], width: { min: 1, max: canvas.width }, height: { min: 1, max: canvas.height } } as MediaTrackCapabilities;
    };
    track.applyConstraints = function () {
      return Promise.resolve();
    };
    const stop = track.stop.bind(track);
    track.stop = function () {
      clearInterval(timer);
      stop();
    };
    return stream;
  };
}

interface Options {
  camera: "bus" | "page" | "device"; // device: Chromium's fake camera (the bus video) where there is one
}

interface Fixtures {
  paidCalls: string[]; // mocked paid endpoints the app asked
  problems: string[]; // what the guard caught
}

// Local runs have no voice clip files: deploy/vercel.sh builds /tts/*.mp3 and /tts/index.json. A 404
// there is expected locally (the app then asks /api/tts), never on a deploy.
function expectedLocally(url: URL, status: number, local: boolean): boolean {
  return local && status === 404 && url.pathname.startsWith("/tts/");
}

export const test = base.extend<Options & Fixtures>({
  camera: ["device", { option: true }],
  paidCalls: async function ({}, provide) {
    await provide([]);
  },
  problems: async function ({}, provide) {
    await provide([]);
  },
  context: async function ({ context, baseURL, browserName, camera, paidCalls }, provide) {
    const origin = new URL(baseURL ?? "http://localhost:3000").origin;
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
    if (!local) {
      // A Preview's Vercel toolbar loads from vercel.live; asked not to (same-origin requests only, so
      // no CORS preflight on other sites).
      await context.route("**/*", function (route) {
        const url = route.request().url();
        if (url.startsWith(origin)) {
          return route.continue({ headers: { ...route.request().headers(), "x-vercel-skip-toolbar": "1" } });
        }
        return route.continue();
      });
    }
    // Server abilities: speech recognition off (typing instead), the Reader's OCR and voice on (mocked
    // below), the rest as the server says.
    await context.route("**/api/health", async function (route) {
      let body: Record<string, unknown> = { ok: true, stt: false, ocr: false };
      try {
        const res = await route.fetch();
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        // no server: the defaults above
      }
      await route.fulfill({ json: { ...body, speech: false, chimege: false, reader_ocr: true, reader_voice: true }, headers: { "Cache-Control": "no-store" } });
    });
    await context.route("**/api/read-sign**", function (route) {
      paidCalls.push("read-sign");
      return route.fulfill({ json: { lines: [], azureMs: 0, serverMs: 0 } });
    });
    await context.route("**/api/reader/ocr", function (route) {
      paidCalls.push("reader/ocr");
      return route.fulfill({
        json: {
          lines: PAGE_LINES.map(function (item) {
            return { text: item, conf: 0.95, breakAfter: true };
          }),
        },
      });
    });
    const wav = silentWav();
    await context.route("**/api/reader/voice", function (route) {
      paidCalls.push("reader/voice");
      return route.fulfill({ body: wav, contentType: "audio/mpeg", headers: { "Cache-Control": "no-store" } });
    });
    await context.route("**/api/stt/**", function (route) {
      paidCalls.push("UNEXPECTED stt " + new URL(route.request().url()).pathname);
      return route.fulfill({ status: 503, json: { detail: "mocked: speech recognition is off in e2e" } });
    });
    const image = camera === "page" ? "page.png" : "bus.jpg";
    await context.route("**/__e2e__/camera", function (route) {
      return route.fulfill({ body: readFileSync(FIXTURES + image), contentType: image.endsWith(".png") ? "image/png" : "image/jpeg" });
    });
    if (browserName === "webkit" || camera !== "device") {
      await context.addInitScript(cameraStandIn, "/__e2e__/camera");
    }
    await provide(context);
  },
  page: async function ({ page, baseURL, problems, paidCalls }, provide) {
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(baseURL ?? "");
    page.on("console", function (msg) {
      if (msg.type() !== "error") {
        return;
      }
      // The browser's own line for an HTTP error: judged by the response check below
      const where = msg.location().url;
      if (/^Failed to load resource: the server responded with a status of 404/.test(msg.text()) && where && expectedLocally(new URL(where), 404, local)) {
        return;
      }
      problems.push("console error: " + msg.text() + (where ? " (" + where + ")" : ""));
    });
    page.on("pageerror", function (e) {
      problems.push("page error: " + e.message);
    });
    page.on("requestfailed", function (req) {
      // Cancelled by the app itself (leaving the camera aborts its reads in flight): not a failure
      if (/^(net::ERR_ABORTED|cancelled)$/i.test(req.failure()?.errorText ?? "") && !req.url().startsWith("blob:")) {
        return;
      }
      problems.push("request failed: " + req.method() + " " + req.url() + " " + (req.failure()?.errorText ?? ""));
    });
    page.on("response", function (res) {
      if (res.status() >= 400 && !expectedLocally(new URL(res.url()), res.status(), local)) {
        problems.push("HTTP " + res.status() + ": " + res.request().method() + " " + res.url());
      }
    });
    await provide(page);
    const unexpected = paidCalls.filter(function (item) {
      return item.startsWith("UNEXPECTED");
    });
    expect(unexpected, "paid services asked although switched off").toEqual([]);
    expect(problems, "console errors, page errors, failed requests, HTTP errors").toEqual([]);
  },
});

export { expect };

// A labelled back button on this screen (NIGHT_PLAN item 1). Soft: the walk goes on to list them all.
export async function expectBack(page: Page, screen: string): Promise<void> {
  await expect.soft(page.getByRole("button", { name: /буцах/i }).first(), "a labelled back button on " + screen).toBeVisible({ timeout: 5000 });
}

const CONTAINERS = new Set(["main", "region", "generic", "group", "list", "listitem", "navigation", "banner", "contentinfo", "document", "form", "section", "article", "none", "presentation"]);

// What a screen reader's swipes stop on, in order (Playwright's aria snapshot, containers left out):
// ["heading Автобус хөтөч", "button Автобус", ...].
export async function swipeOrder(page: Page): Promise<string[]> {
  const yaml = await page.locator("body").ariaSnapshot();
  const out: string[] = [];
  yaml.split("\n").forEach(function (item) {
    const m = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(item);
    const text = /^\s*- text: (.*)$/.exec(item);
    if (text) {
      out.push("text " + text[1].trim());
    } else if (m && !CONTAINERS.has(m[1])) {
      out.push(m[1] + (m[2] !== undefined ? " " + m[2] : ""));
    }
  });
  return out;
}
