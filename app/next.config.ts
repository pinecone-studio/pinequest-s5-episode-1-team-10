import path from "node:path";
import type { NextConfig } from "next";

// FastAPI server (bus data, PaddleOCR, TTS). The browser only talks to /api/*, so one origin
// (and one HTTPS tunnel for a phone) is enough.
const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // shared/ (contract + phrases) sits next to app/.
  turbopack: { root: path.join(process.cwd(), "..") },
  // A stop-name clip that isn't cached yet takes ~8-20 s to synthesize (server/tts.py).
  experimental: { proxyTimeout: 120_000 },
  async rewrites() {
    return [{ source: "/api/:path*", destination: SERVER_URL + "/:path*" }];
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
