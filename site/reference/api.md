# API Reference

The REST API is bearer-token protected except for `/health`, GitHub webhook delivery, and public auth start/poll endpoints.

Use the live OpenAPI document when authenticated:

```sh
export GITTENSORY_API_URL="https://api.gittensory.aethereal.dev"
curl "$GITTENSORY_API_URL/openapi.json" \
  -H "Authorization: Bearer $GITTENSORY_API_TOKEN"
```

## Contributor APIs

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/contributors/:login/profile` | Contributor evidence profile using official Gittensor stats first when available. |
| `GET /v1/contributors/:login/decision-pack` | Canonical private miner decision payload for MCP and internal clients. |
| `GET /v1/contributors/:login/repos/:owner/:repo/decision` | Repo-specific decision extracted from the decision pack. |

## Repo APIs

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/repos` | Known registered and installed repositories. |
| `GET /v1/repos/:owner/:repo` | Repository metadata. |
| `GET /v1/repos/:owner/:repo/intelligence` | Canonical repository intelligence bundle. |
| `GET /v1/repos/:owner/:repo/registration-readiness` | Repo-owner readiness signal for Gittensor registration. |
| `GET /v1/repos/:owner/:repo/gittensor-config-recommendation` | Private Gittensor config recommendation for repo owners. |
| `GET /v1/repos/:owner/:repo/pulls/:number/maintainer-packet` | PR-specific maintainer review packet. |
| `GET /v1/repos/:owner/:repo/pulls/:number/reviewability` | Private PR reviewability score and maintainer action. |

## Local And Preflight APIs

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/local/branch-analysis` | MCP-oriented local branch analysis from structured metadata. |
| `POST /v1/preflight/pr` | Planned PR metadata preflight. |
| `POST /v1/preflight/local-diff` | Local-diff metadata preflight. |

## Agent APIs

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/agent/runs` | Queue a copilot-only agent run and persist run/action context. |
| `GET /v1/agent/runs/:id` | Fetch a persisted agent run, ranked actions, and context snapshots. |
| `POST /v1/agent/plan-next-work` | Return deterministic next-action planning for a GitHub login. |
| `POST /v1/agent/preflight-branch` | Run base-agent preflight against local branch metadata. |
| `POST /v1/agent/prepare-pr-packet` | Prepare a public-safe PR packet from branch metadata. |
| `POST /v1/agent/explain-blockers` | Explain scoreability, queue, role, duplicate, and reviewability blockers privately. |

## Ops APIs

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/readiness` | Service health, signal fidelity, secrets presence, and installation health summary. |
| `GET /v1/sync/status` | Repo sync segments, GitHub totals, rate-limit state, and signal fidelity. |
| `GET /v1/installations` | GitHub App installations and health records. |
| `GET /v1/installations/:id/health` | Exact installation permission/event remediation context. |

## MCP Endpoint

`POST /mcp` exposes remote MCP over Streamable HTTP style requests. The local npm wrapper is still the preferred MCP user surface.
