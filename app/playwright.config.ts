// End-to-end tests in phone emulation (NIGHT_PLAN item 7): an iPhone (WebKit) and a Pixel (Chromium).
//   BASE_URL=https://<preview>.vercel.app VERCEL_AUTOMATION_BYPASS_SECRET=... npx playwright test
//   BASE_URL=http://localhost:3200 npx playwright test         (a local `next start`)
// Fixtures first: server/.venv/bin/python app/e2e/make-fixtures.py (gitignored: bystanders' faces).
// Paid services (Azure, Gemini, ElevenLabs, Speechmatics, Chimege) are always answered by e2e/fixtures.ts;
// bus data (/api/plan, /api/stops) and the voice clips are the real ones.
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
// Ulaanbaatar, Сүхбаатарын талбай: the stop of the bus photos (public/test-fixtures/bus/labels.json).
const GEOLOCATION = { latitude: 47.91709, longitude: 106.91797 };
const AUTH_STATE = "e2e/.auth/state.json"; // the Preview's bypass cookie, saved by e2e/global-setup.ts

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 240_000, // the voice clips of a whole journey are said one after another
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1, // one rider at a time: the bus server and the voice clips are shared
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "mn-MN",
    timezoneId: "Asia/Ulaanbaatar",
    geolocation: GEOLOCATION,
    // Blocked, so page.route sees every request; e2e/sw.spec.ts checks the worker itself.
    serviceWorkers: "block",
    storageState: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? AUTH_STATE : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iphone",
      // WebKit has no fake camera: e2e/fixtures.ts stands in for getUserMedia with a photo.
      use: { ...devices["iPhone 13"], permissions: ["geolocation"] },
    },
    {
      name: "pixel",
      use: {
        ...devices["Pixel 7"],
        permissions: ["geolocation", "camera", "microphone"],
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=e2e/fixtures/bus.y4m", "--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
  ],
});
