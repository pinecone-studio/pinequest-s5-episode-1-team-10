// The installed app (home screen) and its voice clips on the phone. Registered by lib/offline.ts.
// NEVER cached: anything under /api/* (bus data, sign reads, speech, assistant) and camera frames (they
// only ever leave the phone as /api POSTs). Models go straight to the network (the browser's HTTP
// cache handles them).
//   pages (navigations)            network-first: a new deploy shows at once; the kept "/" only when
//                                  offline (app shell)
//   /manifest.webmanifest, icons   kept copy at once, refreshed in the background
//   /tts/*.mp3                     cache-first (a clip never changes: names are content hashes)
//   /tts/index.json                network-first, cached copy when offline (lib/speech.ts needs it)
// Earcons are made in code (lib/speech.ts makeEarcons): no file to keep.
// On install, every clip listed in /tts/index.json is cached in the background (deployed site only).
// Bump VERSION / SHELL to drop the old cache on the next visit.
//
// The reader (/read) is kept offline by the same worker (one worker per scope), in its own cache:
//   /read (the page)               network-first (3 s), kept copy when offline
//   /_next/static/*                cache-first (file names change with their content)
//   /reader-clips/*                cache-first (the reader's fixed sentences, named by their hash)
//   /ort/*, /reader-worker.js      kept copy at once, refreshed in the background
// The page tells which files it used ("keep" message), models are kept by the reader itself
// (lib/reader/modelStore.ts). Bump READER to drop its old cache.
const VERSION = "v2"; // v2: spoken /api/tts answers are no longer kept (v1 kept them)
const CACHE = "voice-" + VERSION;
const INDEX = "/tts/index.json";
const READER = "reader-app-v4";
const SHELL = "shell-v1";
const SHELL_FILES = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-512-maskable.png", "/apple-touch-icon.png"];

self.addEventListener("install", function (event) {
  // No skipWaiting. A new worker that takes the page at once has reloaded the app under the rider.
  event.waitUntil(readerInstall());
  event.waitUntil(shellInstall());
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
              return (
                (item.startsWith("voice-") && item !== CACHE) ||
                (item.startsWith("reader-app-") && item !== READER) ||
                (item.startsWith("shell-") && item !== SHELL)
              );
            })
            .map(function (item) {
              return caches.delete(item);
            }),
        );
      }),
  );
});

function isClip(url) {
  return url.pathname.startsWith("/tts/") && url.pathname.endsWith(".mp3");
}

function cacheFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request.url).then(function (hit) {
      if (hit) {
        return hit;
      }
      return fetch(request).then(function (res) {
        if (res.ok) {
          cache.put(request.url, res.clone());
        }
        return res;
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

// ---- the app shell (installed app) -------------------------------------------------------------

// The start page, manifest and icons, so the home-screen app opens with no signal. One missing file
// never fails the install.
function shellInstall() {
  return caches.open(SHELL).then(function (cache) {
    return Promise.all(
      ["/"].concat(SHELL_FILES).map(function (item) {
        return cache.add(item).catch(function () {});
      }),
    );
  });
}

// Pages: always the network (a new deploy shows at once). Only "/" is kept, for opening offline.
function shellPage(request) {
  const url = new URL(request.url);
  return fetch(request)
    .then(function (res) {
      if (url.pathname === "/" && res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(SHELL).then(function (cache) {
          cache.put("/", copy);
        });
      }
      return res;
    })
    .catch(function () {
      return caches.open(SHELL).then(function (cache) {
        return cache.match(url.pathname).then(function (hit) {
          return hit || Response.error();
        });
      });
    });
}

// Manifest and icons: the kept copy at once, refreshed in the background.
function shellFile(event) {
  const request = event.request;
  return caches.open(SHELL).then(function (cache) {
    return cache.match(request, { ignoreSearch: true }).then(function (hit) {
      const network = fetch(request).then(function (res) {
        if (res.ok) {
          cache.put(new URL(request.url).pathname, res.clone());
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

// ---- the reader (/read) -------------------------------------------------------------------------

// The page and the reader's own fixed sentences (small), so the aiming directions work offline.
function readerInstall() {
  return caches.open(READER).then(function (cache) {
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
    return Promise.all([cache.add("/read").catch(function () {}), clips]);
  });
}

function readerCacheFirst(request) {
  return caches.open(READER).then(function (cache) {
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
function readerStaleWhileRevalidate(event) {
  const request = event.request;
  return caches.open(READER).then(function (cache) {
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
function readerPage(request) {
  return caches.open(READER).then(function (cache) {
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
        return (
          res ||
          cache.match("/read").then(function (hit) {
            return hit || network;
          })
        );
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
    caches.open(READER).then(function (cache) {
      return Promise.all(
        data.urls
          .filter(function (item) {
            const url = new URL(item, self.location.origin);
            return (
              url.origin === self.location.origin &&
              (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/ort/") || url.pathname === "/reader-worker.js")
            );
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
  if (request.method !== "GET" || request.headers.has("range")) {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // Server answers and anything the camera sends: never kept, never touched.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return;
  }
  if (request.mode === "navigate" && url.pathname.startsWith("/read")) {
    event.respondWith(readerPage(request));
  } else if (request.mode === "navigate") {
    event.respondWith(shellPage(request));
  } else if (SHELL_FILES.indexOf(url.pathname) !== -1) {
    event.respondWith(shellFile(event));
  } else if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/reader-clips/")) {
    event.respondWith(readerCacheFirst(request));
  } else if (url.pathname.startsWith("/ort/") || url.pathname === "/reader-worker.js") {
    event.respondWith(readerStaleWhileRevalidate(event));
  } else if (isClip(url)) {
    event.respondWith(cacheFirst(request));
  } else if (url.pathname === INDEX) {
    event.respondWith(networkFirst(request));
  }
  // Everything else: not handled, the browser fetches it as if there were no worker.
});
