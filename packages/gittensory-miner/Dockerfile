# Fleet-mode image for @jsonbored/gittensory-miner (#4295). Build context = monorepo root:
#   docker build -f packages/gittensory-miner/Dockerfile -t gittensory-miner:latest .
# SECRETS ARE NEVER BAKED: supply operator credentials at `docker run` time only.
# Persistent SQLite ledgers live on a mounted volume (default GITTENSORY_MINER_CONFIG_DIR=/data/miner).

ARG GITTENSORY_VERSION=

# --- build: workspace install + engine compile + miner syntax check ----------------------------
FROM public.ecr.aws/docker/library/node:24-slim AS build
WORKDIR /app
# Full source BEFORE `npm ci`: npm workspaces only symlinks packages that already exist on disk.
# Same ordering fix as the root gittensory-api Dockerfile — @jsonbored/gittensory-engine must be
# present when `npm ci` runs or gittensory-miner's workspace dependency cannot resolve.
COPY . .
RUN npm ci --ignore-scripts
RUN npm --workspace @jsonbored/gittensory-engine run build
RUN npm --workspace @jsonbored/gittensory-miner run build
RUN npm prune --omit=dev --ignore-scripts

# --- runtime: non-root CLI image with a mounted config volume -----------------------------------
FROM public.ecr.aws/docker/library/node:24-slim AS runtime
WORKDIR /app
ARG GITTENSORY_VERSION=
ENV NODE_ENV=production \
    GITTENSORY_MINER_CONFIG_DIR=/data/miner \
    GITTENSORY_MINER_VERSION=${GITTENSORY_VERSION} \
    PATH=/app/node_modules/.bin:$PATH
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/gittensory-miner ./packages/gittensory-miner
COPY --from=build --chown=node:node /app/packages/gittensory-engine ./packages/gittensory-engine
RUN mkdir -p /data/miner && chown -R node:node /data
USER node
VOLUME ["/data/miner"]
# No HEALTHCHECK: the miner is a batch/CLI workload (`docker run … gittensory-miner <cmd>`), not a
# long-running HTTP service — there is no steady-state endpoint to probe unless an operator wraps
# the container in their own supervising loop.
ENTRYPOINT ["gittensory-miner"]
CMD ["doctor"]
