# Fleet-mode image for @loopover/miner (#4295). Build context = monorepo root:
#   docker build -f packages/loopover-miner/Dockerfile -t loopover-miner:latest .
# SECRETS ARE NEVER BAKED: supply operator credentials at `docker run` time only.
# Persistent SQLite ledgers live on a mounted volume (default LOOPOVER_MINER_CONFIG_DIR=/data/miner).

ARG LOOPOVER_VERSION=

# --- build: workspace install + engine compile + miner syntax check ----------------------------
FROM public.ecr.aws/docker/library/node:24-slim AS build
WORKDIR /app
# Full source BEFORE `npm ci`: npm workspaces only symlinks packages that already exist on disk.
# Same ordering fix as the root loopover-api Dockerfile — @loopover/engine must be
# present when `npm ci` runs or loopover-miner's workspace dependency cannot resolve.
COPY . .
RUN npm ci --ignore-scripts
RUN npm --workspace @loopover/engine run build
RUN npm --workspace @loopover/miner run build
RUN npm prune --omit=dev --ignore-scripts

# --- runtime: non-root CLI image with a mounted config volume -----------------------------------
FROM public.ecr.aws/docker/library/node:24-slim AS runtime
WORKDIR /app
ARG LOOPOVER_VERSION=
ENV NODE_ENV=production \
    LOOPOVER_MINER_CONFIG_DIR=/data/miner \
    LOOPOVER_MINER_VERSION=${LOOPOVER_VERSION} \
    PATH=/app/node_modules/.bin:$PATH
# #7857: dnsmasq/iptables/ipset implement the network-egress firewall (deny-by-default, allowlisted via the
# operator's own .loopover-ams.yml); gosu drops from root to the node user after that firewall is set up --
# see egress-firewall-entrypoint.sh for the full mechanism and why this image now starts as root.
RUN apt-get update && apt-get install -y --no-install-recommends dnsmasq iptables ipset gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/loopover-miner ./packages/loopover-miner
COPY --from=build --chown=node:node /app/packages/loopover-engine ./packages/loopover-engine
RUN mkdir -p /data/miner && chown -R node:node /data \
    && chmod 755 /app/packages/loopover-miner/scripts/egress-firewall-entrypoint.sh
VOLUME ["/data/miner"]
# No HEALTHCHECK: the miner is a batch/CLI workload (`docker run … loopover-miner <cmd>`), not a
# long-running HTTP service — there is no steady-state endpoint to probe unless an operator wraps
# the container in their own supervising loop.
#
# #7857: this image now starts as ROOT (no `USER node` here) so the entrypoint can set up the egress firewall,
# which needs root/NET_ADMIN to configure iptables/ipset -- but it never RUNS the miner itself as root. The
# entrypoint's own last action is `exec gosu node loopover-miner ...`, which both drops privileges AND replaces
# the entrypoint process (`exec`, not a child) -- the actual miner command runs as `node`, exactly as it always
# has, for the entire remainder of the container's life. `docker-compose.miner.yml` grants the NET_ADMIN/NET_RAW
# capabilities this setup step needs (see that file's own comment); `LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL` is
# the documented opt-out for an operator who hits a real snag (see the entrypoint script's own header).
ENTRYPOINT ["/app/packages/loopover-miner/scripts/egress-firewall-entrypoint.sh"]
CMD ["doctor"]
