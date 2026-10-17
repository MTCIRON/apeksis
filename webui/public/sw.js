// Apeksis PWA service worker — intentionally minimal.
//
// The app is a live tool against the gateway over HTTPS, so we MUST NOT cache
// API responses or hashed bundles (stale JS/assets or cached /v1 audio would be
// wrong). This worker only exists to satisfy installability; every request
// falls through to the network untouched.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// No fetch handler: default network passthrough.
