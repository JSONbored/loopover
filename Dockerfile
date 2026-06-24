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

# --- runtime: slim, non-root ----------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLATFORM=self-hosted \
    PORT=8787 \
    DATABASE_PATH=/data/gittensory.sqlite \
    MIGRATIONS_DIR=/app/migrations
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
# Optional: bake the Claude Code / Codex CLIs so the `claude-code` / `codex` subscription providers (#979)
# work in-image. Build with `--build-arg INSTALL_AI_CLIS=true`. No credentials are baked — operators mint
# CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) / codex auth at run time and pass it via the env.
ARG INSTALL_AI_CLIS=false
RUN if [ "$INSTALL_AI_CLIS" = "true" ]; then npm install -g @anthropic-ai/claude-code@2.1.187 @openai/codex@0.142.0 --ignore-scripts; fi
# Optional: enable visual review via an external Chrome sidecar (e.g. `browserless/chrome:latest`).
# Build with `--build-arg INSTALL_VISUAL_REVIEW=true` then set BROWSER_WS_ENDPOINT=<ws-url> at runtime.
ARG INSTALL_VISUAL_REVIEW=false
COPY --from=build /app/package*.json ./
RUN if [ "$INSTALL_VISUAL_REVIEW" = "true" ]; then npm install puppeteer-core@22.13.1 --ignore-scripts; fi
# Data dir (the SQLite file) — owned by the unprivileged node user; mount a volume here to persist.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
