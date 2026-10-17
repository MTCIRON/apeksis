import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Served under the nginx TLS reverse proxy at /ui/. `base` keeps every asset
// URL relative to that path; the app talks to the same origin (/v1, /healthz,
// /models, ...) through the proxy.
//
// Cross-origin isolation (COOP/COEP) is what lets onnxruntime-web use
// SharedArrayBuffer (multi-threaded wasm). Production hosting sets the same
// headers at nginx (webui/nginx.conf); here it is for `vite dev`/`preview`.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Dev parity: `npm run dev` alone has NO /v1 backend, so every call would 404
// with `http_error`. We proxy the API + health + model + WS routes to the
// running TLS edge (default https://localhost:8443) so the dev server hits REAL
// endpoints and behaves like production. Override with VOXI_DEV_UPSTREAM.
const upstream = process.env.VOXI_DEV_UPSTREAM ?? "https://localhost:8443";
const edge = { target: upstream, changeOrigin: true, secure: false } as const;

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    headers: isolation,
    proxy: {
      // WebSocket routes live under /v1 too (wss upgrade), hence ws: true here.
      "/v1": { ...edge, ws: true },
      "/healthz": edge,
      "/readyz": edge,
      "/models": edge,
      "/ui/runtime.json": edge,
    },
  },
  preview: { headers: isolation },
  // onnxruntime-web ships prebuilt workers/wasm; excluding it from dep
  // optimization keeps its own `new Worker(new URL(...))` references intact.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
