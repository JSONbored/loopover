# LoopOver discovery-index service (#4250, #7164, #7167). Standalone Hono/Node service (the actual runtime
# CMD below is unchanged whether run via plain Docker or, per #7167, a Cloudflare Container). Build context
# is the REPOSITORY ROOT, not this directory — it depends on the @loopover/engine workspace package
# (packages/loopover-engine), so the build stage copies the whole monorepo root and installs via npm
# workspaces rather than `npm ci` inside this directory alone. See README.md's Deployment section for the
# exact build invocation (`docker build -f packages/discovery-index/Dockerfile .` from the repo root).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/loopover-engine/package.json packages/loopover-engine/package.json
COPY packages/discovery-index/package.json packages/discovery-index/package.json
RUN npm ci --workspace @loopover/engine --workspace @loopover/discovery-index --include-workspace-root
COPY packages/loopover-engine packages/loopover-engine
COPY packages/discovery-index packages/discovery-index
RUN npm run build --workspace @loopover/engine \
  && npm run build --workspace @loopover/discovery-index \
  && npm run validate:sourcemaps --workspace @loopover/discovery-index \
  && npm prune --omit=dev --workspace @loopover/discovery-index

FROM node:22-slim AS runtime
# Least privilege: run as a non-root user.
RUN useradd --create-home --uid 10001 discovery-index
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/loopover-engine/node_modules ./packages/loopover-engine/node_modules
COPY --from=build --chown=discovery-index:discovery-index /app/packages/loopover-engine/dist ./packages/loopover-engine/dist
COPY --from=build --chown=discovery-index:discovery-index /app/packages/loopover-engine/package.json ./packages/loopover-engine/package.json
COPY --from=build --chown=discovery-index:discovery-index /app/packages/discovery-index/dist ./packages/discovery-index/dist
COPY --from=build --chown=discovery-index:discovery-index /app/packages/discovery-index/package.json ./packages/discovery-index/package.json
WORKDIR /app/packages/discovery-index
USER discovery-index
ENV PORT=8080
EXPOSE 8080
# Provide at runtime (NOT baked into the image): DISCOVERY_INDEX_SHARED_SECRET (bearer auth for callers),
# DISCOVERY_INDEX_GITHUB_TOKEN (this service's own GitHub token, isolated from any other component's),
# SENTRY_DSN/SENTRY_ENVIRONMENT/SENTRY_RELEASE (error tracking, #4934 -- optional, no-op when SENTRY_DSN is
# unset), and for source-map upload specifically: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT (also
# optional -- upload-sourcemaps.ts skips itself with a log line, never fails the boot, when any is unset).
#
# upload-sourcemaps.js runs FIRST, at container startup (not baked into the image at build time, since
# SENTRY_AUTH_TOKEN is a runtime-only secret) -- deletes the .map files it just uploaded before the server
# starts, so they're never served or left on disk in the running container. Mirrors
# review-enrichment/Dockerfile's identical CMD shape.
CMD ["sh", "-c", "node dist/upload-sourcemaps.js && find dist -type f -name '*.map' -delete && node dist/server.js"]
