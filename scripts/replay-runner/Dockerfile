# Reproducible replay-runner image (#9214, epic #8534). Runs the attested-backtest-run CLI headlessly:
# replay a rule's corpus, collect attestation evidence, and print the outcome as JSON. Build context = monorepo
# root (this script depends on the @loopover/engine workspace package):
#   docker build -f scripts/replay-runner/Dockerfile -t loopover-replay-runner:latest .
#
# Base image is pinned BY DIGEST (not a mutable tag) -- see replay-runner-image-manifest.json's baseImageRef
# and replay-runner/README.md's "What is and isn't reproducible" section for what this pin does and doesn't
# guarantee. Bumping the base image is a manifest change, checked by `npm run replay-runner-manifest:check`.
#
# NO SECRETS ARE BAKED: the container never holds a GitHub token, a D1/Postgres credential, or an enrollment
# secret. Its own replay + attestation-collection path is corpus-in, JSON-out with no runtime network access;
# the optional `--persist` flag on the underlying CLI (which shells out to `wrangler d1 execute --remote`) is
# deliberately NOT reachable from this image's default command -- persistence is an operator-invoked, separate
# step outside what this measured image runs.

FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /app
# package.json/package-lock.json + the engine's own manifest BEFORE the rest of the tree, so `npm ci`'s layer
# only invalidates on a real dependency change -- same ordering as packages/discovery-index/Dockerfile.
# tsconfig.json is required too: packages/loopover-engine/tsconfig.json `extends` it.
# Deliberately NO --include-workspace-root: that flag would also install the ROOT package.json's OWN
# "dependencies" (the main Worker app's deps -- @anthropic-ai/claude-agent-sdk's full weight, sharp,
# @cloudflare, drizzle-orm, ...), none of which @loopover/engine's build or runtime needs -- typescript
# itself is @loopover/engine's OWN devDependency, not something borrowed from the root. Omitting the flag
# keeps this stage scoped to exactly what the engine package declares.
COPY package.json package-lock.json tsconfig.json ./
COPY packages/loopover-engine/package.json packages/loopover-engine/package.json
RUN npm ci --workspace @loopover/engine --ignore-scripts
COPY packages/loopover-engine packages/loopover-engine
RUN npm run build --workspace @loopover/engine \
  && npm prune --omit=dev --workspace @loopover/engine --ignore-scripts

# --- runtime-deps: tsx alone, via its OWN committed lockfile (scripts/replay-runner/tsx-runtime/), in an
# isolated install -- keeping the full root devDependency tree (typescript, eslint, vitest, ...) just to
# retain tsx would make this image an order of magnitude larger than "minimal" requires (#9214), and a bare
# `npm install tsx@x.y.z` with no lockfile would re-resolve tsx's own transitive deps at build time instead of
# reproducing the exact, pinned tree -- this stage stays `npm ci`, lockfile-only, like every other install in
# this Dockerfile. tsx is the ONLY thing scripts/**'s extensionless-specifier convention needs at runtime that
# isn't already a normal runtime dependency of @loopover/engine.
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime-deps
WORKDIR /app
COPY scripts/replay-runner/tsx-runtime/package.json scripts/replay-runner/tsx-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
RUN useradd --create-home --uid 10001 replay-runner
WORKDIR /app
ENV NODE_ENV=production
# `"type": "module"` here is load-bearing, not incidental: tsx (and Node's own loader) determine a file's
# module format from the nearest package.json, and without one present the entrypoint script's top-level
# await fails under tsx's CJS default.
COPY --from=build /app/package.json ./package.json
COPY --from=runtime-deps /app/node_modules ./node_modules
# @loopover/engine is constructed here directly from its own compiled output -- NOT `npm ci`'d -- because npm
# would install every dependency the FULL package declares (@anthropic-ai/claude-agent-sdk, tree-sitter-wasms,
# ...), regardless of which files this image actually imports. attester.js/attestation-envelope.js/
# backtest-corpus.js's entire runtime closure is these three files plus node:crypto (verified: `grep -n
# "^import" packages/loopover-engine/dist/calibration/*.js` -- attested-backtest-run.ts's own subpath imports,
# #9214, are what make this closure reachable without ever loading the barrel's web-tree-sitter/
# claude-agent-sdk-carrying re-export graph in the first place). This measured image is meant to run inside
# an eventual TEE (#8534); keeping its dependency footprint to exactly what replay needs is a real security
# property (a smaller trusted computing base), not a size optimization for its own sake.
COPY --from=build --chown=replay-runner:replay-runner /app/packages/loopover-engine/package.json ./node_modules/@loopover/engine/package.json
COPY --from=build --chown=replay-runner:replay-runner /app/packages/loopover-engine/dist/calibration/attester.js ./node_modules/@loopover/engine/dist/calibration/attester.js
COPY --from=build --chown=replay-runner:replay-runner /app/packages/loopover-engine/dist/calibration/attestation-envelope.js ./node_modules/@loopover/engine/dist/calibration/attestation-envelope.js
COPY --from=build --chown=replay-runner:replay-runner /app/packages/loopover-engine/dist/calibration/backtest-corpus.js ./node_modules/@loopover/engine/dist/calibration/backtest-corpus.js
# The runner script's own sources -- listed individually (rather than `COPY scripts/`) so this image's content
# is EXACTLY the set replay-runner-image-manifest.json enumerates under sourceFiles; adding a new script
# dependency here without a matching manifest entry is precisely the drift `replay-runner-manifest:check` catches.
COPY --chown=replay-runner:replay-runner scripts/attested-backtest-run.ts scripts/attested-backtest-run.ts
COPY --chown=replay-runner:replay-runner scripts/attested-backtest-run-core.ts scripts/attested-backtest-run-core.ts
COPY --chown=replay-runner:replay-runner scripts/backtest-corpus-export-core.ts scripts/backtest-corpus-export-core.ts
COPY --chown=replay-runner:replay-runner scripts/snp-attester.ts scripts/snp-attester.ts
USER replay-runner
# No HEALTHCHECK: this is a one-shot replay job (`docker run … <flags>`, exits after one attested run), not a
# long-running service -- there is no steady-state endpoint to probe, matching packages/loopover-miner's own
# batch-CLI image for the same reason.
#
# Run via tsx, not bare `node --experimental-strip-types`: scripts/**'s relative imports are extensionless
# (#9221, matching src/**'s Bundler resolution) -- tsx resolves that; plain Node's ESM loader cannot without
# an explicit extension. This is the SAME runner every scripts/** CLI already uses elsewhere in the repo (CI's
# calibration-advisory.yml, this repo's own real-subprocess test suites); it arrives here via the isolated
# runtime-deps stage above, not by keeping @loopover/engine's own devDependencies around.
ENTRYPOINT ["node_modules/.bin/tsx", "scripts/attested-backtest-run.ts"]
