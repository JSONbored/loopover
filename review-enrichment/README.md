# Review-enrichment service (REES)

A standalone Railway microservice that produces a structured **review brief** for the gittensory review engine.

The engine reviews PRs by running a headless `claude --print` subprocess with `Bash`/`WebFetch` disallowed and **no
repo checkout**, so it cannot run a linter, hit a CVE database, resolve a dependency tree, or query git history. REES
fills exactly that gap: given a PR it runs heavy/external/historical analysis and returns a pre-rendered, public-safe
brief the engine splices into the prompt next to grounding + RAG. It is strictly **additive and fail-safe** — the engine
treats any timeout/error as "no brief" and proceeds.

## API

| Route             | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `GET /health`     | Liveness (Railway healthcheck).                                                 |
| `GET /ready`      | Readiness.                                                                      |
| `POST /v1/enrich` | `Authorization: Bearer <REES_SHARED_SECRET>` → `EnrichRequest` → `ReviewBrief`. |

See `src/server.ts` for the `EnrichRequest` / `ReviewBrief` contract.

## Analyzers (added behind the contract)

- **#1474** dependency-diff + OSV.dev CVE
- **#1502** lockfile-only transitive vulnerability drift via OSV.dev
- **#1475** SPDX license policy
- **#1476** gitleaks-grade secret scan (value-redacted)
- **#1477** static analysis + complexity (lint/semgrep over the diff)
- **#1478** history (author track record, similar past PRs, linked-issue alignment)

## Run locally

```sh
npm install
REES_SHARED_SECRET=dev npm run build && npm start   # listens on :8080
curl localhost:8080/health
curl -XPOST localhost:8080/v1/enrich -H 'authorization: Bearer dev' \
  -H 'content-type: application/json' -d '{"repoFullName":"o/r","prNumber":1}'
```

## Deploy (Railway)

Separate service from the engine. Set **Root Directory = `review-enrichment`** so Railway reads this folder's
`railway.json` + `Dockerfile`. Set `REES_SHARED_SECRET` (same value the engine holds) as a service variable — never
commit it. The engine reaches the service over Railway **private networking** (`<service>.railway.internal`); no public
domain is required.
