# Self-host image for gittensory-api (#980). Runs the SAME Worker handlers on Node via src/server.ts —
# the Cloudflare bindings become self-host adapters (D1 -> node:sqlite, Queue -> in-process). The hosted
# Cloudflare Worker (wrangler) deploy is unaffected. SECRETS ARE NEVER BAKED: supply them at run time via
# the .env file or mounted *_FILE secrets (see docker-compose.yml + .env.example).

# --- build: install deps + bundle the Node entry --------------------------------------------------------
# ECR Public Gallery mirrors Docker Official Images with no rate limits and no auth.
FROM public.ecr.aws/docker/library/node:24-slim AS build
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: no native builds are needed (SQLite is the built-in node:sqlite; @hono/node-server is
# pure JS; esbuild ships its binary as an optional dependency, not a script).
RUN npm ci --ignore-scripts
COPY . .
# --all: bundle every dependency into one self-contained dist/server.mjs, so the runtime image needs no
# node_modules (≈10× smaller). The bundle has zero `cloudflare:*` imports (stubbed at build), so no loader.
RUN node scripts/build-selfhost.mjs --all
RUN node scripts/validate-selfhost-sourcemap.mjs

# --- runtime base: slim, non-root -----------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:24-slim AS runtime-base
WORKDIR /app
ARG GITTENSORY_VERSION=
ENV NODE_ENV=production \
    PLATFORM=self-hosted \
    PORT=8787 \
    DATABASE_PATH=/data/gittensory.sqlite \
    MIGRATIONS_DIR=/app/migrations \
    NPM_CONFIG_PREFIX=/home/node/.npm-global \
    GITTENSORY_VERSION=${GITTENSORY_VERSION}
# Optional: bake the Claude Code / Codex CLIs so the `claude-code` / `codex` subscription providers (#979)
# work in-image. Build with `--build-arg INSTALL_AI_CLIS=true`. No credentials are baked — operators mint
# CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) / codex auth at run time and pass it via the env.
ARG INSTALL_AI_CLIS=false
# codex's native (Rust) binary loads the SYSTEM CA trust store (rustls-native-certs); node:slim ships none, so the
# `codex` provider fails every call with "no native root CA certificates found" without ca-certificates.
RUN if [ "$INSTALL_AI_CLIS" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*; fi
# claude-code's postinstall downloads its platform-native binary, so scripts must run. Install the optional
# CLIs as the unprivileged user into a user-owned prefix while /app is still root-owned, keeping lifecycle
# hooks from mutating the already-copied application bundle during the image build.
RUN mkdir -p /home/node/.npm-global /home/node/.npm && chown -R node:node /home/node/.npm-global /home/node/.npm
USER node
RUN if [ "$INSTALL_AI_CLIS" = "true" ]; then npm install -g @anthropic-ai/claude-code@2.1.187 @openai/codex@0.142.0; fi
USER root
# Optional: enable visual review via an external Chrome sidecar (e.g. `browserless/chrome:latest`).
# Build with `--build-arg INSTALL_VISUAL_REVIEW=true` then set BROWSER_WS_ENDPOINT=<ws-url> at runtime.
ARG INSTALL_VISUAL_REVIEW=false
COPY package*.json ./
RUN if [ "$INSTALL_VISUAL_REVIEW" = "true" ]; then npm install puppeteer-core@22.13.1 --ignore-scripts; fi
# Data dir (the SQLite file) — owned by the unprivileged node user; mount a volume here to persist.
RUN mkdir -p /data && chown -R node:node /data /app
# Expose the optional user-installed CLIs only after all root build steps have completed, so a
# lifecycle script cannot poison PATH for later root RUN commands.
ENV PATH=/home/node/.npm-global/bin:$PATH
USER node
EXPOSE 8787
# Probe /ready (not /health): /health is a liveness stub that returns 200 even when the DB is down,
# whereas /ready returns 503 until the DB answers and migrations are applied. start-period tolerates the
# Postgres cold start (waitForPostgres blocks up to 30s before the HTTP server even binds).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]

# Maintainer release images are built from the already-built, Sentry-injected bundle in the workflow. The source map
# is uploaded to Sentry there and is deliberately not copied into the runtime image.
FROM runtime-base AS runtime-prebuilt
COPY --chown=node:node dist/server.mjs ./dist/server.mjs
COPY --chown=node:node migrations ./migrations

# Default local/operator builds still build the bundle inside Docker, but only the JS bundle reaches runtime.
FROM runtime-base AS runtime
COPY --from=build --chown=node:node /app/dist/server.mjs ./dist/server.mjs
COPY --from=build --chown=node:node /app/migrations ./migrations
