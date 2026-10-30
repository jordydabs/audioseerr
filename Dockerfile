# ─────────────────────────────────────────────────────────────────────────────
# AudioSeerr — hardened multi-stage image
#
# Base image is PINNED (Node 24 LTS on a fixed Alpine) instead of a floating
# tag like :latest or :24-alpine, so builds are reproducible and you know
# exactly what ships. For maximum supply-chain integrity, pin to a digest:
#     FROM node:24-alpine3.24@sha256:<digest>
# Get the digest with:  docker buildx imagetools inspect node:24-alpine3.24
# and enable Docker Content Trust when pulling:  DOCKER_CONTENT_TRUST=1
#
# A pin only stays safe while upstream still maintains it: once Node or Alpine
# reaches end-of-life its tags stop being rebuilt and quietly stop getting
# security patches. Re-check both schedules when bumping, and at least yearly:
#     https://nodejs.org/en/about/previous-releases
#     https://alpinelinux.org/releases/
#
# Alpine keeps the package surface (and therefore the CVE surface) small.
# Scan the built image before deploying, e.g.:
#     docker scout cves audioseerr:latest      # or:  trivy image audioseerr:latest
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: install production dependencies only ────────────────────────────
FROM node:24-alpine3.24 AS deps
WORKDIR /app
COPY package*.json ./
# package-lock.json is now committed, so this takes the `npm ci` branch: exact,
# reproducible versions. Previously no lockfile existed, so every build silently
# resolved fresh transitive dependencies — the fallback was the only path ever
# taken, which is the opposite of the reproducibility the comment claimed.
# --omit=dev keeps devDependencies out of the runtime image.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      echo "WARNING: no package-lock.json — build is not reproducible" && \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# ── Stage 2: minimal runtime ─────────────────────────────────────────────────
FROM node:24-alpine3.24 AS runtime
ENV NODE_ENV=production
# PORT is honoured by the app, the HEALTHCHECK and EXPOSE below, so overriding
# it at run time actually works end to end.
ENV PORT=7575
WORKDIR /app

# --chown on COPY instead of a trailing `RUN chown -R node:node /app`: that
# rewrote every file into a second copy of the whole app + node_modules in a new
# layer (roughly doubling image size), and left the application code writable by
# the very user that runs it. Files are now owned correctly as they land, and
# the app tree stays read-only to the runtime user.
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package*.json ./
COPY --chown=root:root server.js ./
COPY --chown=root:root public ./public

# The data directory is a volume at runtime, but create it owned by node so a
# named volume (or a first run without a bind mount) is writable out of the box.
RUN mkdir -p /app/data && chown node:node /app/data

# Run as the unprivileged "node" user that ships with the image (uid/gid 1000)
# — never as root.
USER node

EXPOSE ${PORT}

# Liveness probe hits the unauthenticated /api/health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
