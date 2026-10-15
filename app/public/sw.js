// Voice clips on the phone: the app's fixed sentences play at once, even with no signal.
// Registered by lib/offline.ts. Only voice is cached here; models, /ort and every other /api call go
// straight to the network (the browser's HTTP cache handles models).
//   /tts/*.mp3, /api/tts?text=...  cache-first (a clip never changes: names are content hashes)
//   /tts/index.json                network-first, cached copy when offline (lib/speech.ts needs it)
// On install, every clip listed in /tts/index.json is cached in the background (deployed site only).
// Bump VERSION to drop the old cache on the next visit.
const VERSION = "v1";
const CACHE = "voice-" + VERSION;
const INDEX = "/tts/index.json";

self.addEventListener("install", function (event) {
  self.skipWaiting();
  // ~185 clips (~2 MB) inside waitUntil, or the browser may stop the worker halfway. The page works
  // normally meanwhile (no worker yet = plain network); one failed clip never fails the install.
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return fetch(INDEX)
        .then(function (res) {
          if (!res.ok) {
            return null; // dev / local: no index, nothing to pre-cache
          }
          cache.put(INDEX, res.clone());
          return res.json();
        })
        .then(function (index) {
          if (!index) {
            return;
          }
          const urls = Array.from(
            new Set(
              Object.values(index).map(function (item) {
                return "/tts/" + item + ".mp3";
              }),
            ),
          );
          return precache(cache, urls);
        })
        .catch(function () {});
    }),
  );
});

// A few at a time, skipping clips already cached, so a slow line isn't flooded.
function precache(cache, urls) {
  let next = 0;
  function worker() {
    if (next >= urls.length) {
      return Promise.resolve();
    }
    const url = urls[next++];
    return cache
      .match(url)
      .then(function (hit) {
        return hit ? null : fetch(url).then(function (res) {
          return res.ok ? cache.put(url, res) : null;
        });
      })
      .catch(function () {})
      .then(worker);
  }
  return Promise.all([worker(), worker(), worker(), worker()]);
}

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (item) {
              return item.startsWith("voice-") && item !== CACHE;
            })
            .map(function (item) {
              return caches.delete(item);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function isClip(url) {
  return (url.pathname.startsWith("/tts/") && url.pathname.endsWith(".mp3")) || (url.pathname === "/api/tts" && url.searchParams.has("text"));
}

// /api/tts answers with a redirect to /tts/<name>.mp3: store the final audio as a plain response.
function plain(res) {
  if (!res.redirected) {
    return Promise.resolve(res);
  }
  return res.blob().then(function (body) {
    return new Response(body, { status: 200, headers: { "Content-Type": res.headers.get("Content-Type") || "audio/mpeg" } });
  });
}

function cacheFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request.url).then(function (hit) {
      if (hit) {
        return hit;
      }
      return fetch(request).then(function (res) {
        if (!res.ok) {
          return res;
        }
        return plain(res).then(function (clean) {
          cache.put(request.url, clean.clone());
          return clean;
        });
      });
    });
  });
}

function networkFirst(request) {
  return fetch(request)
    .then(function (res) {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(function (cache) {
          cache.put(request.url, copy);
        });
      }
      return res;
    })
    .catch(function () {
      return caches.match(request.url).then(function (hit) {
        return hit || Response.error();
      });
    });
}

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (isClip(url)) {
    event.respondWith(cacheFirst(request));
  } else if (url.pathname === INDEX) {
    event.respondWith(networkFirst(request));
  }
  // Everything else: not handled, the browser fetches it as if there were no worker.
});
