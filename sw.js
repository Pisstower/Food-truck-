const CACHE = "trailer-pos-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./main.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // sql.js CDN files you use below (pin versions!)
  "https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/sql-wasm.js",
  "https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/sql-wasm.wasm"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener("activate", e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }))
  );
});
