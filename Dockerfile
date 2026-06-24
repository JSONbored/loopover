# Self-host image for gittensory-api (#980). Runs the SAME Worker handlers on Node via src/server.ts —
# the Cloudflare bindings become self-host adapters (D1 -> node:sqlite, Queue -> in-process). The hosted
# Cloudflare Worker (wrangler) deploy is unaffected. SECRETS ARE NEVER BAKED: supply them at run time via
# the .env file or mounted *_FILE secrets (see docker-compose.yml + .env.example).

# --- build: install deps + bundle the Node entry --------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: no native builds are needed (SQLite is the built-in node:sqlite; @hono/node-server is
# pure JS; esbuild ships its binary as an optional dependency, not a script).
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/build-selfhost.mjs

# --- runtime: slim, non-root ----------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLATFORM=self-hosted \
    PORT=8787 \
    DATABASE_PATH=/data/gittensory.sqlite \
    MIGRATIONS_DIR=/app/migrations
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts/register-selfhost.mjs ./scripts/register-selfhost.mjs
# Data dir (the SQLite file) — owned by the unprivileged node user; mount a volume here to persist.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The register hook stubs cloudflare:* imports so the Worker graph loads on Node.
CMD ["node", "--import", "./scripts/register-selfhost.mjs", "dist/server.mjs"]
