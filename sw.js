/* sw.js — service worker.
 *
 * The whole point: after one visit the app opens on the beach with the network
 * off. So the shell is precached on install and served cache-first forever;
 * anything else goes straight to the network and is never cached.
 *
 * MAINTENANCE — there is no build step, so this list is kept by hand.
 * Add a file to js/, css/ or fonts/ and you MUST add it to SHELL below and
 * bump VERSION, or phones will keep serving the old app from cache.
 */

const VERSION = "v1";
const CACHE = `nsc-race-day-${VERSION}`;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg",
  "./css/app.css",

  "./js/app.js",
  "./js/router.js",
  "./js/db.js",
  "./js/sync.js",
  "./js/resume.js",
  "./js/pages/setup.js",
  "./js/pages/signon.js",
  "./js/pages/checklist.js",
  "./js/pages/sequence.js",
  "./js/pages/live.js",
  "./js/pages/results.js",
  "./js/pages/standdown.js",
  "./js/pages/dev.js",

  "./fonts/barlow-condensed-500.woff2",
  "./fonts/barlow-condensed-600.woff2",
  "./fonts/barlow-condensed-700.woff2",
  "./fonts/ibm-plex-sans-400.woff2",
  "./fonts/ibm-plex-sans-500.woff2",
  "./fonts/ibm-plex-sans-600.woff2",
  "./fonts/ibm-plex-mono-400.woff2",
  "./fonts/ibm-plex-mono-500.woff2",
  "./fonts/ibm-plex-mono-600.woff2",
];

/* Absolute URLs of the shell, resolved against wherever this worker is served
   from — the app lives at /nsc-race-day/ on GitHub Pages and at / locally. */
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never touch writes. Supabase pushes in Phase 2 must fail honestly when
  // offline so sync.js can retry them, not be silently swallowed here.
  if (request.method !== "GET") return;

  // Any navigation renders the one app shell; routing is client-side.
  if (request.mode === "navigate") {
    event.respondWith(cacheFirst(INDEX_URL));
    return;
  }

  const url = new URL(request.url);
  if (SHELL_URLS.has(url.href)) {
    event.respondWith(cacheFirst(url.href));
    return;
  }

  // Everything else: straight through, uncached.
});

async function cacheFirst(url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return hit;
  try {
    const response = await fetch(url);
    if (response.ok) cache.put(url, response.clone());
    return response;
  } catch (err) {
    // Offline and not in cache. Nothing useful to say; let it fail.
    return Response.error();
  }
}

// Lets a future "update available" prompt activate a waiting worker.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
