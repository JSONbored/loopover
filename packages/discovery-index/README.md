# Discovery-index service

A standalone microservice implementing the hosted half of the [discovery plane](../loopover-miner/docs/discovery-plane-operator-guide.md) (#4250): a shared, cached GitHub issue/search index that opted-in `loopover-miner` instances can query instead of each independently fanning out to GitHub's search/listing APIs. Metadata-only — see [`@loopover/engine`'s discovery-index contract](../loopover-engine/src/discovery-index-contract.ts) for the exact public-safe candidate shape and the forbidden-field boundary this service can never cross. See [`OPERATIONS.md`](OPERATIONS.md) for the maintainer-facing retention/abuse/incident-response doc.

This is optional, shared infrastructure to reduce duplicate GitHub API pressure across the miner fleet (the rate-limit incident this mitigates: #1936). Self-hosted AMS/ORB deployments are completely unaffected whether or not this service exists — opting in is a separate, default-off client change (#7168).

## API

| Route                            | Purpose                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /health`                    | Liveness health check.                                                                          |
| `GET /ready`                     | Readiness — checks this service's own GitHub token is configured.                               |
| `GET /metrics`                   | Prometheus text-format metrics.                                                                 |
| `POST /v1/discovery-index/query` | `Authorization: Bearer <DISCOVERY_INDEX_SHARED_SECRET>` → `DiscoveryIndexRequest` → `DiscoveryIndexResponse`. |
| `POST /v1/discovery-index/soft-claim` | `Authorization: Bearer <DISCOVERY_INDEX_SHARED_SECRET>` → the payload shape `discovery-soft-claim.ts`'s `buildSoftClaimRequest` produces → `{contractVersion, accepted, ageMs}`. |

See `packages/loopover-engine/src/discovery-index-contract.ts` for the full query request/response contract (`normalizeDiscoveryIndexRequest`/`normalizeDiscoveryIndexResponse`), which this service both consumes and emits through, and `packages/loopover-engine/src/discovery-soft-claim.ts` for the soft-claim payload builder.

Soft-claim design note: the shipped client payload never carries caller identity (`buildSoftClaimRequest` hardcodes `note`/`instanceId` to `null`) — this endpoint only ever sees `repoFullName` + `issueNumber` + `action`. A repeat `claim` call on a still-active key is reported as `accepted: false` (with the existing claim's age) and refreshes its TTL, since there is no identity on the wire to distinguish "the same caller checking in" from "a different caller."

## Configuration

| Env var                             | Purpose                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `DISCOVERY_INDEX_SHARED_SECRET`     | Bearer secret required to call `/v1/discovery-index/*`. Unset ⇒ the service fails closed (503). |
| `DISCOVERY_INDEX_GITHUB_TOKEN`      | This service's own GitHub token, isolated from any other component's (REES, the main engine's installation tokens, etc.). Unset ⇒ `/ready` reports not-ready. |
| `DISCOVERY_INDEX_CACHE_TTL_MS`      | TTL for cached query results, per unique `(repos, orgs, searchTerms)` scope. Default `300000` (5 minutes). |
| `DISCOVERY_INDEX_SOFT_CLAIM_TTL_MS` | TTL for a soft claim before it's reclaimable. Default `1800000` (30 minutes).                   |
| `PORT`                              | HTTP port. Default `8080`.                                                                      |
| `POSTHOG_API_KEY` / `POSTHOG_HOST` / `POSTHOG_ENVIRONMENT` / `POSTHOG_RELEASE` | PostHog error tracking (#8289). Unset ⇒ PostHog stays inert (no-op) everywhere, matching this repo's other services. `POSTHOG_API_KEY` is a write-only project token, safe as a plain `wrangler.jsonc` var once set; `POSTHOG_RELEASE` is set per-deploy, not static — see `wrangler.jsonc`'s header comment. **Pending #7875** (a real, loopover-owned PostHog project) — currently unset everywhere, so this stays a complete no-op. |
| `POSTHOG_CLI_API_KEY` / `POSTHOG_CLI_PROJECT_ID` / `POSTHOG_CLI_HOST` | PostHog **personal** API key (error-tracking write + organization read scopes, distinct from `POSTHOG_API_KEY`'s project token) + numeric project id, used only by `upload-sourcemaps.ts` at container startup to upload this build's source maps. `POSTHOG_CLI_API_KEY` is genuinely sensitive — always a `wrangler secret`. Unset ⇒ source-map upload skips itself with a log line; never fails the boot. **Pending #7875**, same as above. |

## Error tracking & releases (#4934, #8289)

Runtime errors (route handler failures, unhandled rejections/exceptions) report into PostHog. See `src/posthog.ts` for the full redaction rules (secret-named fields and GitHub-token-shaped values are always filtered before anything leaves the process) and `OPERATIONS.md`'s Monitoring section for how this fits alongside `/metrics`. This surface previously reported into the shared `metagraphed` Sentry project (`jsonbored` org) that this repo's other infra/operational pieces flow into -- a genuine cross-project entanglement -- until #8289 replaced it outright.

Source maps and release tracking are handled by `src/upload-sourcemaps.ts`, which runs as the **first step of the container's runtime `CMD`** (not at Docker build time — `POSTHOG_CLI_API_KEY` is a runtime-only secret, never baked into an image layer): it injects PostHog chunk ids, uploads the exact post-injection source maps, then verifies at least one symbol set exists for the release via `scripts/validate-posthog-release.mjs` (queries PostHog's `error_tracking/symbol_sets` API — PostHog's release model has no equivalent of Sentry's commits/deploys/finalize lifecycle, so this is a narrower check by design), before deleting the `.map` files it just uploaded and starting `server.ts`. Any step failing is non-fatal to the boot unless `DISCOVERY_INDEX_POSTHOG_UPLOAD_STRICT=true` is set. `posthog-cli sourcemap inject`/`upload` run with an explicit `--release-version` (not the CLI's own git-metadata auto-detection — the Docker build stage never copies `.git` into the image).

## Deployment

The production deployment (#7167) is a **Cloudflare Container**, not a bare VPS/Docker host: `wrangler.jsonc` runs the exact same `Dockerfile` as a Container behind a Durable Object, giving it a public URL (`discovery.loopover.ai`) and TLS with no manual DNS/reverse-proxy setup. This was chosen over a raw VPS/PaaS deploy because it reuses the same platform already chosen for the ORB+AMS hosted control-plane (#7173), and over native (non-Container) Workers because this service's cache (`cache.ts`) and soft-claim dedup store (`soft-claim.ts`) are both in-process memory — a Container is one real, persistent process (so that state behaves correctly, exactly as already tested), where Workers' distributed isolates would not reliably share it. See `src/worker.ts`'s header comment for why the config pins `max_instances: 1` (a correctness requirement for soft-claim dedup, not just a cost choice).

**First-time setup**, from this directory:

```sh
npx wrangler secret put DISCOVERY_INDEX_SHARED_SECRET   # never commit a real value
npx wrangler secret put DISCOVERY_INDEX_GITHUB_TOKEN    # never commit a real value
npm run cf:typegen                                       # regenerate worker-configuration.d.ts after any wrangler.jsonc change
                                                          # (wraps `wrangler types` -- raw wrangler output has
                                                          # trailing whitespace that fails this repo's git diff --check)
npx wrangler deploy
```

`npm run cf:dev` runs it locally against Cloudflare's dev runtime; `npm run cf:typecheck` type-checks `src/worker.ts` against the Workers runtime types (kept in a separate `tsconfig.worker.json` from this package's own Node build — see that file's header comment for why).

**Local, non-Cloudflare testing** (no wrangler/Containers involved) still works exactly as before via the plain Docker image:

```sh
docker build -f packages/discovery-index/Dockerfile -t loopover-discovery-index .
docker run -p 8080:8080 -e DISCOVERY_INDEX_SHARED_SECRET=... -e DISCOVERY_INDEX_GITHUB_TOKEN=... loopover-discovery-index
```
