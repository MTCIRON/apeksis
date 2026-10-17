# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# Voxi WebUI — dedicated FRONTEND container.
#
# Stage 1 compiles the SPA (tsc + vite). Stage 2 is a plain nginx that serves the
# static bundle under /ui/ plus the F6 punctuation ONNX asset. This is its OWN
# service/container in the cluster, so Docker Desktop shows a `webui-1` row with
# its own Logs tab, and `docker compose logs webui` prints every frontend request
# (nginx access log → stdout) and any static 404 — just like the other services.
#
# It is internal-only (no published port): the TLS `proxy` edge reaches it by
# service DNS on the `speech` network and forwards /ui there.
#
# Build from the REPO ROOT (context: .):
#   docker compose -f compose.yaml -f infra/compose.proxy.yaml build webui
# -----------------------------------------------------------------------------

# --- Build the SPA -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install from the lockfile first for a reproducible, cached dependency layer.
COPY webui/package.json webui/package-lock.json ./
RUN npm ci

# Then the sources (.dockerignore keeps node_modules/dist out of this copy).
COPY webui/ ./ 
# Model packs are served from the shared /models path (webui/.env is excluded
# from the build context by the root .dockerignore, so pass the base explicitly).
RUN VITE_MODELS_BASE_URL=/models npm run build
# -> /app/dist  (base "/ui/", so asset URLs are /ui/…)

# --- Serve the static bundle -------------------------------------------------
FROM nginx:1.27-alpine AS serve

# Minimal static server (SPA fallback + model assets); logs go to stdout/
# stderr (stock alpine symlinks), so they surface in `docker logs` / Desktop.
COPY webui/nginx.conf /etc/nginx/conf.d/default.conf

# Built WebUI bundle, served at the /ui/ location. This is the whole app: the
# The studio workspace is compiled into it (no separate legacy build).
COPY --from=build /app/dist /usr/share/nginx/html/ui

EXPOSE 8080
