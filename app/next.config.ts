import path from "node:path";
import type { NextConfig } from "next";

// FastAPI server (bus data, PaddleOCR, TTS). The browser only talks to /api/*, so one origin
// (and one HTTPS tunnel for a phone) is enough.
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8000";
// A deploy of your own (free, from GitHub) has no voice clips: CLIPS_URL=https://avtobus-khotoch.vercel.app
// plays the main deploy's pre-made clips (its bus server: the env var above set to that site + "/api").
const CLIPS_URL = process.env.CLIPS_URL;

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // shared/ (contract + phrases) sits next to app/.
  turbopack: { root: path.join(process.cwd(), "..") },
  // A stop-name clip that isn't cached yet takes ~8-20 s to synthesize (server/tts.py).
  experimental: { proxyTimeout: 120_000 },
  async rewrites() {
    const rules = [{ source: "/api/:path*", destination: SERVER_URL + "/:path*" }];
    return CLIPS_URL ? rules.concat([{ source: "/tts/:path*", destination: CLIPS_URL + "/tts/:path*" }]) : rules;
  },
  async headers() {
    // Cross-origin isolation lets onnxruntime-web use multi-threaded WASM.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
