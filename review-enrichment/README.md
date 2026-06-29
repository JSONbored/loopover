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
- **#1508** IaC / config misconfiguration audit over changed infra/config files
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

## Sentry releases and source maps

REES supports optional Sentry error reporting and source-map upload for Railway deployments. The Docker image builds
`dist/*.js.map` with embedded `sourcesContent`, then the runtime startup command injects Sentry debug ids, uploads the
exact post-injection `dist/` files, records a deploy, removes source maps from the running filesystem, and starts
`dist/server.js`.

Set these Railway service variables:

| Variable                    | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `SENTRY_DSN`                | Enables REES error capture. Unset means the SDK is a no-op.             |
| `SENTRY_AUTH_TOKEN`         | Allows the runtime uploader to create releases and upload source maps.  |
| `SENTRY_ORG`                | Sentry organization slug.                                               |
| `SENTRY_PROJECT`            | Sentry project slug.                                                    |
| `SENTRY_ENVIRONMENT`        | Optional; defaults to Railway's environment name, then `production`.    |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional; defaults to `0`, so errors report without tracing.            |
| `SENTRY_RELEASE`            | Optional override. Only set it when that exact REES bundle is uploaded. |
| `SENTRY_URL`                | Optional Sentry API URL; defaults to `https://sentry.io`.               |
| `SENTRY_REPOSITORY`         | Optional; defaults to `JSONbored/gittensory` for commit association.    |
| `REES_SENTRY_UPLOAD_STRICT` | Optional. Set `true` to fail startup if source-map upload fails.        |
| `REES_SENTRY_VALIDATE_RELEASE` | Optional. Set `false` only to disable post-upload release validation. |

By default the release id is `gittensory-rees@<RAILWAY_GIT_COMMIT_SHA>`, using Railway's Git metadata. The Sentry
GitHub code mapping should be:

| Sentry field      | Value               |
| ----------------- | ------------------- |
| Stack Trace Root  | `/app`              |
| Source Code Root  | `review-enrichment` |
| Branch            | `main`              |

Do **not** pass `SENTRY_AUTH_TOKEN` as a Docker build arg. Railway deploys this service from Git, and Docker build args
can leak through image metadata. Keeping the upload at runtime means Sentry sees the same `dist/` files that the service
executes, without exposing source maps over HTTP.

After upload, startup validates the exact `gittensory-rees@<RAILWAY_GIT_COMMIT_SHA>` release through the Sentry API:
the release must exist, be finalized, include the deployed commit, and include the Railway deploy id/environment. If
`REES_SENTRY_UPLOAD_STRICT=true`, a failed upload or failed validation stops the Railway deployment; otherwise it logs a
`rees_sentry_sourcemap_upload_failed` warning so the problem is visible without blocking startup.

Analyzer failures are still fail-open: the `/v1/enrich` response marks the analyzer as `degraded` and returns a partial
brief. When Sentry is enabled, those degradations are captured as `rees_analyzer_degraded` events with tags for
`analyzer`, `repo`, `pullNumber`, `headSha`, `release`, `environment`, and `timeoutMs`. Use those tags to spot a broken
analyzer without exposing request bodies, diffs, tokens, or review content.

If Sentry still shows frames such as `/app/dist/server.js`, check:

1. The event's `release` is `gittensory-rees@<same Railway commit sha>` or your exact `SENTRY_RELEASE` override.
2. The Sentry release has an artifact bundle uploaded for the REES project.
3. Railway has `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` set on the REES service.
4. Startup logs include `sentry_release_validation_complete` for the same release id and Railway deployment id.
5. The Sentry code mapping is `/app` → `review-enrichment` on branch `main`.
6. `npm --prefix review-enrichment run validate:sourcemaps` passes locally.
