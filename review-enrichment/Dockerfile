# Gittensory review-enrichment service (REES). Lean two-stage Node build; analyzers add CLI tools later (#1477).
# Build context = the review-enrichment/ directory (Railway "Root Directory" = review-enrichment).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
# Least privilege: run as a non-root user.
RUN useradd --create-home --uid 10001 rees
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER rees
ENV PORT=8080
EXPOSE 8080
# Provide at runtime (NOT baked into the image): REES_SHARED_SECRET (shared bearer with the engine).
CMD ["node", "dist/server.js"]
