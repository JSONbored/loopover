# Discovery-index service

A standalone microservice implementing the hosted half of the [discovery plane](../loopover-miner/docs/discovery-plane-operator-guide.md) (#4250): a shared, cached GitHub issue/search index that opted-in `loopover-miner` instances can query instead of each independently fanning out to GitHub's search/listing APIs. Metadata-only — see [`@loopover/engine`'s discovery-index contract](../loopover-engine/src/discovery-index-contract.ts) for the exact public-safe candidate shape and the forbidden-field boundary this service can never cross.

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

## Deployment

Build and run via the included `Dockerfile` (build context = the **repository root**, since this service depends on the `@loopover/engine` workspace package):

```sh
docker build -f packages/discovery-index/Dockerfile -t loopover-discovery-index .
docker run -p 8080:8080 -e DISCOVERY_INDEX_SHARED_SECRET=... -e DISCOVERY_INDEX_GITHUB_TOKEN=... loopover-discovery-index
```

Hosting/DNS/TLS/observability wiring for a public deployment is tracked separately (#7167), not part of this service's own code.
