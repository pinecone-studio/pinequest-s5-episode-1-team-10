// Reads the text on one bus-sign crop with Azure AI Vision Image Analysis 4.0 (features=read, synchronous).
// The phone sends the crop as raw JPEG and decides itself (lib/parse-sign.ts); this only hides the key.
// Region: no `preferredRegion` export. Next 16 deprecates it, and on Vercel it accepts only
// auto/global/home (other values fail the deploy). deploy/vercel.sh already pins every function to icn1 (Seoul).
import { Agent } from "undici";
import type { ReadSignResponse } from "../../../../shared/contract";

// One connection pool per server instance, kept open between requests (Node's own fetch closes an idle
// connection after 4 s): no new TCP + TLS handshake to Azure per read. The phone's warm-up (?warm=1,
// every 60 s while the bus screen is open) keeps it, and the function, warm.
const azure = new Agent({ keepAliveTimeout: 90_000, keepAliveMaxTimeout: 600_000, connections: 8 });

const API_VERSION = "2023-10-01";
const MIN_WORD_CONFIDENCE = 0.8; // below: the word becomes "?", so a doubtful read can't become a "yes"
const MAX_BYTES = 4 * 1024 * 1024; // Vercel's request body limit is 4.5 MB
const AZURE_TIMEOUT_MS = 3000;

interface AzureWord {
  text: string;
  confidence: number;
}

interface AzureLine {
  text: string;
  words?: AzureWord[];
}

interface AzureResult {
  readResult?: { blocks?: { lines?: AzureLine[] }[] };
}

function fail(status: number, error: string, headers?: Record<string, string>): Response {
  return Response.json({ error: error }, { status: status, headers: headers });
}

function lineText(line: AzureLine): string {
  if (!line.words || !line.words.length) {
    return line.text;
  }
  // A doubtful word of 1-2 characters may be a route letter ("55 ?" may be 55Б): "?" keeps the number
  // doubtful. A longer one is a word of the destination ("455 ДЭНЖИЙН 1000-Е" read with ДЭНЖИЙН unsure):
  // "…", so it can't block a clear route number (test photo 1 never reached "yes" with "?").
  return line.words
    .map(function (item) {
      return item.confidence >= MIN_WORD_CONFIDENCE ? item.text : item.text.length <= 2 ? "?" : "…";
    })
    .join(" ");
}

export async function POST(request: Request): Promise<Response> {
  const begun = performance.now();
  const warm = new URL(request.url).searchParams.get("warm") === "1";
  const endpoint = process.env.AZURE_VISION_ENDPOINT;
  const key = process.env.AZURE_VISION_KEY;
  if (!endpoint || !key) {
    return fail(503, "AZURE_VISION_ENDPOINT / AZURE_VISION_KEY not set");
  }
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim() !== "image/jpeg") {
    return fail(415, "send the crop as image/jpeg");
  }
  const image = await request.arrayBuffer();
  if (!image.byteLength) {
    return fail(400, "empty image");
  }
  if (image.byteLength > MAX_BYTES) {
    return fail(413, "image over 4 MB");
  }
  const url = endpoint.replace(/\/+$/, "") + "/computervision/imageanalysis:analyze?api-version=" + API_VERSION + "&features=read";
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/octet-stream" },
      body: image,
      signal: AbortSignal.timeout(AZURE_TIMEOUT_MS),
      cache: "no-store",
      dispatcher: azure,
    } as RequestInit & { dispatcher: Agent });
  } catch (e) {
    return fail(502, "Azure did not answer: " + (e instanceof Error ? e.name : String(e)));
  }
  const timingMs = Math.round(performance.now() - started);
  if (res.status === 429) {
    // Free tier (F0): 20 calls a minute for the whole key. The phone waits this long.
    return fail(429, "Azure rate limit", { "Retry-After": res.headers.get("retry-after") ?? "10" });
  }
  if (!res.ok) {
    const detail = await res.text().catch(function () {
      return "";
    });
    return fail(502, "Azure " + res.status + " " + detail.slice(0, 200));
  }
  const result = (await res.json()) as AzureResult;
  const lines: string[] = [];
  (result.readResult?.blocks ?? []).forEach(function (item) {
    (item.lines ?? []).forEach(function (line) {
      lines.push(lineText(line));
    });
  });
  const serverMs = Math.round(performance.now() - begun);
  console.log("[read-sign] " + (warm ? "warm " : "") + image.byteLength + " bytes, azure " + timingMs + " ms, server " + serverMs + " ms");
  const body: ReadSignResponse = { lines: warm ? [] : lines, azureMs: timingMs, serverMs: serverMs };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
