# Gittensory review-enrichment service (REES). Lean two-stage Node build; analyzers are pure-JS diff-hunk
# heuristics with no external CLI tools (#1477 scoped this to the cheap, no-checkout path -- see
# review-enrichment/src/analyzers/complexity.ts's header for why a real linter/AST toolchain is out of scope).
# Build context = the review-enrichment/ directory (Railway "Root Directory" = review-enrichment).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run validate:sourcemaps && npm prune --omit=dev

FROM node:22-slim AS runtime
# Least privilege: run as a non-root user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 rees
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build --chown=rees:rees /app/scripts ./scripts
COPY --from=build --chown=rees:rees /app/dist ./dist
COPY --from=build --chown=rees:rees /app/package.json ./package.json
USER rees
ENV PORT=8080
EXPOSE 8080
# Provide at runtime (NOT baked into the image): REES_SHARED_SECRET (shared bearer with the engine),
# plus optional Sentry vars. The uploader no-ops unless Sentry auth/org/project/release are configured.
CMD ["sh", "-c", "node dist/upload-sourcemaps.js && find dist -type f -name '*.map' -delete && node dist/server.js"]
