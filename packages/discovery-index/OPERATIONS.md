# Discovery-index operating doc (maintainer-only)

This is the server-side operating doc the client guide ([`discovery-plane-operator-guide.md`](../loopover-miner/docs/discovery-plane-operator-guide.md)) refers to. It restates this service's own retention/abuse boundaries for whoever operates it (#4250), and is not published to the public docs website — the public-facing side of this contract is the client guide above.

## What this service is

The hosted half of the discovery plane: a shared, cached GitHub issue/search index that opted-in `loopover-miner` instances query instead of each independently fanning out to GitHub's search/listing APIs, plus fleet-wide soft-claim dedup so two miners don't start duplicate work on the same issue. See [`README.md`](README.md) for the API surface and [#7167](https://github.com/JSONbored/loopover/issues/7167) for the deployment shape (a single Cloudflare Container instance).

**It is optional, shared, owner-operated infrastructure** — self-hosted AMS/ORB deployments work identically whether or not this service exists or is reachable. Nothing here ever gates core self-host functionality.

## What is retained

- Cached GitHub issue/search **metadata only** (titles, labels, counts, timestamps, URLs) — the exact shape `@loopover/engine`'s [`discovery-index-contract.ts`](../loopover-engine/src/discovery-index-contract.ts) defines, for up to `DISCOVERY_INDEX_CACHE_TTL_MS` (default 5 minutes).
- Soft-claim records: `repoFullName#issueNumber` → claim timestamp, for up to `DISCOVERY_INDEX_SOFT_CLAIM_TTL_MS` (default 30 minutes). No caller identity is stored alongside a claim — the shipped client payload never sends one (see `soft-claim.ts`'s own header comment).
- Rate-limit buckets: `ip:<address>` → request count, for a 60-second rolling window (`rate-limiter.ts`).

All of the above are **in-process memory only** — nothing is written to disk or a database. Restarting the container (a redeploy, a sleep/wake cycle) clears all of it. There is no backup, export, or retention beyond the TTLs above by design.

## What is never retained or transmitted

Same boundary the client guide documents, restated from the server's own side:

- Source file contents, patches, diffs, full issue/PR bodies, or review comments.
- GitHub tokens, PATs, App private keys, or any actor-capable credential belonging to a *caller* (this service's own `DISCOVERY_INDEX_GITHUB_TOKEN` is used only to call GitHub's own API on the caller's behalf; it is never echoed back in a response or log line).
- Caller identity of any kind (login, IP is used transiently for rate-limiting only — see below — never persisted alongside a cache entry or claim).
- Reward amounts, wallet addresses, hotkeys, trust scores, or private rankings — this service has no concept of any of these and never will.

## Abuse posture (#4250)

All opted-in miners authenticate with **one shared `DISCOVERY_INDEX_SHARED_SECRET`** — there is no per-caller identity on the wire (`soft-claim.ts`'s client contract deliberately carries none), so per-caller rate-limiting isn't possible without a bigger redesign (individual caller tokens). The mitigation in place instead:

- A blanket, **IP-keyed** rate limit (`rate-limiter.ts`, enforced in `worker.ts` ahead of the Container) — 60 requests/minute per source IP, applied only to `/v1/discovery-index/*` (the real work; `/health`/`/ready`/`/metrics` are exempt for uptime monitors).
- Fails **open** on a rate-limiter Durable Object error — an unrelated Cloudflare-side hiccup degrades to "unlimited" rather than an outage for every legitimate caller (same fail-open reasoning as the main app's own rate limiter, `src/auth/rate-limit.ts`).
- This bounds a single misbehaving IP, not a distributed abuser rotating source IPs while holding the shared secret. If that ever becomes a real, observed problem (not just a theoretical one), the real fix is issuing **per-installation** secrets instead of one shared one — a bigger change, tracked as a follow-up if and when it's actually needed, not built speculatively now.

## Incident response

**If `DISCOVERY_INDEX_SHARED_SECRET` leaks or is suspected compromised:**
1. `npx wrangler secret put DISCOVERY_INDEX_SHARED_SECRET` with a new value — this immediately invalidates the old one for every caller (shared-secret model, no per-caller revocation needed).
2. Redistribute the new secret to legitimate opted-in operators through whatever channel currently exists for that (this doc doesn't define that channel — it's not built yet as of #7167; today there are no real opted-in operators to notify).
3. No data-exfiltration concern from the leak itself: per "What is retained" above, there is nothing sensitive to steal even with full API access — the worst case is cache pollution or soft-claim griefing (a malicious "claim" call blocking a real miner from an issue for up to 30 minutes), not data exposure.

**If `DISCOVERY_INDEX_GITHUB_TOKEN` leaks:**
1. Revoke it directly on GitHub (this service's own token, isolated from every other component's per `README.md`'s Configuration table — revoking it affects only this service).
2. `npx wrangler secret put DISCOVERY_INDEX_GITHUB_TOKEN` with a freshly generated token.

**If abuse is observed (rate-limit denials spiking, or GitHub API quota exhaustion on `DISCOVERY_INDEX_GITHUB_TOKEN`):**
1. Check `/metrics` (Prometheus text format) for `discovery_index_query_requests_total`/`discovery_index_soft_claim_requests_total` by status, and Cloudflare's own Worker observability (enabled in `wrangler.jsonc`) for per-IP request volume.
2. A single abusive IP is already capped by the rate limiter; if the pattern is distributed (many IPs, one shared secret), rotating the shared secret (above) is the only real lever until per-installation secrets exist.

## Monitoring

`/health` (liveness) and `/ready` (readiness — reports whether `DISCOVERY_INDEX_GITHUB_TOKEN` is configured) are the two routes an external uptime check should poll; both are exempt from the rate limit. `/metrics` exposes Prometheus-format counters/histograms for request outcomes and latency. This service is **not** wired into the self-host fleet's own Grafana/Alloy stack — it isn't a self-hosted instance, it's the one hosted plane, deployed and observed separately (Cloudflare's own Worker observability, per `wrangler.jsonc`) rather than folded into infrastructure that assumes a self-hoster's own box.
