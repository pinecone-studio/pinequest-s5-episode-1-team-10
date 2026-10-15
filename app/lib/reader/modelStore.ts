// Model files for the reader, kept in the browser's Cache Storage after the first download, so the
// reader works offline and never downloads them again (the HTTP cache may drop big files).
// Bump CACHE when a model file changes name or content.
const CACHE = "reader-models-v1";

export type Progress = (loaded: number, total: number) => void;

async function download(url: string, onProgress: Progress): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(url + ": " + res.status);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  parts.forEach(function (item) {
    out.set(item, at);
    at += item.length;
  });
  return out;
}

export async function modelFile(url: string, onProgress: Progress): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      onProgress(bytes.length, bytes.length);
      return bytes;
    }
  } catch {
    cache = null; // private window, storage blocked: just download
  }
  const bytes = await download(url, onProgress);
  if (cache) {
    // `bytes` owns its whole buffer (made by download)
    cache.put(url, new Response(bytes.buffer as ArrayBuffer, { headers: { "Content-Type": "application/octet-stream" } })).catch(function () {
      // storage full: works, but downloads again next time
    });
  }
  return bytes;
}
