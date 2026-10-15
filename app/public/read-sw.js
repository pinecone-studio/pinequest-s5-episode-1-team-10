// Service worker for the reader (registered by components/Reader.tsx): keeps the reader's page, its
// code and onnxruntime in the phone so it opens and reads with no internet after the first visit.
// Scope "/" only because the reader's workers live under /_next/static/ and must be served offline
// too; it answers only: the /read page, /_next/static/* (file names change with content) and /ort/*.
// Everything else (the bus screens' pages, /api, /tts, models) goes to the network untouched; models
// are kept by the reader itself (lib/reader/modelStore.ts).
// v4: the reader's worker is a plain file (/reader-worker.js); onnxruntime patched to fit older
// iPhones' memory (scripts/copy-ort.mjs); the reader's own sentences kept offline (/reader-clips/):
// the old copies must go.
const CACHE = "reader-app-v4";

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        // the reader's fixed sentences too (small): so the aiming directions work offline
        const clips = fetch("/reader-clips/index.json")
          .then(function (res) {
            return res.json();
          })
          .then(function (index) {
            const names = Object.keys(index).map(function (item) {
              return "/reader-clips/" + index[item] + ".m4a";
            });
            return cache.addAll(["/reader-clips/index.json"].concat(names));
          })
          .catch(function () {});
        return Promise.all([cache.add("/read"), clips]);
      })
      .catch(function () {})
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (item) {
              return item.startsWith("reader-app-") && item !== CACHE;
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

function cacheFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) {
        return hit;
      }
      return fetch(request).then(function (res) {
        if (res.ok) {
          cache.put(request, res.clone());
        }
        return res;
      });
    });
  });
}

// The kept copy at once, refreshed in the background (onnxruntime's file names stay the same across
// its releases, so it must not be kept forever).
function staleWhileRevalidate(event) {
  const request = event.request;
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      const network = fetch(request).then(function (res) {
        if (res.ok) {
          cache.put(request, res.clone());
        }
        return res;
      });
      if (hit) {
        event.waitUntil(network.catch(function () {}));
        return hit;
      }
      return network;
    });
  });
}

// The page itself: the newest when online (3 s at most), the kept copy when not.
function pageNetworkFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    const network = fetch(request).then(function (res) {
      if (res.ok) {
        cache.put("/read", res.clone());
      }
      return res;
    });
    const timeout = new Promise(function (resolve) {
      setTimeout(resolve, 3000);
    });
    return Promise.race([network, timeout])
      .then(function (res) {
        return res || cache.match("/read").then(function (hit) {
          return hit || network;
        });
      })
      .catch(function () {
        return cache.match("/read").then(function (hit) {
          return hit || Response.error();
        });
      });
  });
}

// The page and its workers say which files they used (Reader.tsx, engine.ts): kept, so the next visit
// works offline even if the first one loaded them before this worker was running.
self.addEventListener("message", function (event) {
  const data = event.data || {};
  if (data.type !== "keep" || !Array.isArray(data.urls)) {
    return;
  }
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(
        data.urls
          .filter(function (item) {
            const url = new URL(item, self.location.origin);
            return url.origin === self.location.origin && (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/ort/"));
          })
          .map(function (item) {
            return cache.match(item).then(function (hit) {
              return hit ? undefined : cache.add(item).catch(function () {});
            });
          }),
      );
    }),
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (request.mode === "navigate" && url.pathname.startsWith("/read")) {
    event.respondWith(pageNetworkFirst(request));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request)); // file names change with their content
  } else if (url.pathname.startsWith("/reader-clips/")) {
    event.respondWith(cacheFirst(request)); // named by the sentence's hash
  } else if (url.pathname.startsWith("/ort/") || url.pathname === "/reader-worker.js") {
    event.respondWith(staleWhileRevalidate(event));
  }
});
