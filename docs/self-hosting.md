# Self-hosting Gittensory

Gittensory ships as a Cloudflare Worker, but the **same** review engine runs unchanged on a plain Node
container so you can self-host it next to your own GitHub App. `docker compose up` gives you the full
reviewer — webhooks, the deterministic gate, AI summaries, the maintain/sweep cron, and (optionally) full
maintainer autonomy — backed by a local SQLite database.

> **How it works (one paragraph).** The Worker's Cloudflare bindings are swapped for self-host adapters and
> nothing else changes: **D1 → `node:sqlite`** (a faithful `D1Database` shim, so Drizzle + every raw query +
> all 56 schema migrations run byte-for-byte the same), **Queue → an in-process FIFO worker** (same
> `processJob`), and the **cron** is a timer that calls the same `scheduled()` handler. The Hono app is served
> with `@hono/node-server`. See [`src/server.ts`](../src/server.ts) and [`src/selfhost/`](../src/selfhost).

## Documentation map

This page is the overview + quick start. Deeper topics live in [`docs/self-host/`](./self-host/):

| Guide                                             | What's in it                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Configuration](./self-host/configuration.md)     | The three config layers, the container-private `.gittensory.yml`, every env var, the `features:` block         |
| [AI providers](./self-host/ai-providers.md)       | claude-code / codex / anthropic / ollama, model + effort + timeout, cost/usage metrics, token-spend protection |
| [RAG indexing](./self-host/rag-indexing.md)       | qdrant + ollama embed stack, indexing your repos, the on-demand endpoint, namespacing                          |
| [Review modes](./self-host/review-modes.md)       | advisory vs dry-run vs live, autonomy, the converged features, the 1-review-per-PR guarantee                   |
| [Troubleshooting](./self-host/troubleshooting.md) | The real failure modes (CLI not baked, 429 quota, no embed provider, stale index) + fixes                      |
| [Review configuration](./review-configuration.md) | The full `.gittensory.yml` gate/settings/review schema                                                         |

---

## 1. Quick start

```bash
cp .env.example .env          # then edit .env — see §3
docker compose up --build
curl localhost:8787/health    # {"status":"ok"}
```

On first boot the container creates the SQLite database on the `gittensory-data` volume and applies all 56
migrations automatically (`{"event":"selfhost_migrations_applied","count":56}` in the logs). Point your
GitHub App's webhook at `https://<your-host>/v1/github/webhook` (expose port 8787 behind your own TLS).

**Or use the published image** (multi-arch, ~254 MB) instead of building:

```bash
docker run -p 8787:8787 --env-file .env -v gittensory-data:/data \
  ghcr.io/<owner>/gittensory-selfhost:latest      # or pin a version, e.g. :0.1.0
```

To run without Docker:

```bash
npm ci
node scripts/build-selfhost.mjs           # external mode (fast local rebuilds)
node --import ./scripts/register-selfhost.mjs dist/server.mjs
```

Releases are cut by pushing a `selfhost-v<semver>` tag (e.g. `selfhost-v0.1.0`): CI builds the multi-arch
image, pushes it to GHCR with `:<version>`, `:latest`, and `:sha-…` tags (with provenance + SBOM), and opens a
GitHub Release. Official release images also bake `GITTENSORY_VERSION=gittensory-selfhost@<version>` so Sentry
events can be matched to the release/source maps uploaded by the release workflow.

---

## 2. Create the GitHub App

**One-click (recommended):** before setting any GitHub secrets, set `PUBLIC_API_ORIGIN` and a long random
`SELFHOST_SETUP_TOKEN`, boot the container, then visit **`/setup`** and enter your `SELFHOST_SETUP_TOKEN`
in the form (the token is sent in the POST body, never the URL, so it can't leak to logs or browser history).
It creates the App for you via GitHub's App-manifest flow (correct permissions/events + webhook URL), then
writes the credentials to `/data/gittensory-app.env`. Add those to your `.env`, install the App on your repos,
and restart. `/setup` requires the setup token and is disabled once `GITHUB_APP_ID` is set, so it can't rebind
a live install. (Scripted setups can pass the token via an `x-setup-token` header instead.)

**Or manually**, create a GitHub App (the hosted gittensory[bot] is separate) with:

- **Webhook URL** `https://<your-host>/v1/github/webhook`, and a **webhook secret** (→ `GITHUB_WEBHOOK_SECRET`).
- **Permissions**: Pull requests (read/write), Contents (read; read/write if you want merge), Issues
  (read/write), Checks (read/write), Metadata (read). Commit statuses (read).
- **Events**: Pull request, Pull request review, Push, Issues, Check suite, Check run, Status.
- Generate a **private key** (→ `GITHUB_APP_PRIVATE_KEY`), and note the **App ID** (→ `GITHUB_APP_ID`) and the
  app **slug** (→ `GITHUB_APP_SLUG`). Install the app on the repos you want reviewed.

---

## 3. Configuration

Everything is environment variables — see [`.env.example`](../.env.example) for the annotated list (it holds
**sample placeholders only; never commit a real `.env`** — it is gitignored). The required core secrets:

| Variable                                                               | What it is                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GITHUB_APP_ID` / `GITHUB_APP_SLUG`                                    | your GitHub App's id + slug                                                    |
| `GITHUB_APP_PRIVATE_KEY`                                               | the App's PKCS#8 private key (or mount `GITHUB_APP_PRIVATE_KEY_FILE`)          |
| `GITHUB_WEBHOOK_SECRET`                                                | the webhook secret you set on the App                                          |
| `GITTENSOR_REGISTRY_URL`                                               | registry endpoint (or any reachable placeholder if you don't use the registry) |
| `GITTENSORY_API_TOKEN` / `GITTENSORY_MCP_TOKEN` / `INTERNAL_JOB_TOKEN` | bearer tokens — generate your own (`openssl rand -hex 32`)                     |

Runtime knobs: `PORT` (default 8787), `DATABASE_PATH` (default `/data/gittensory.sqlite`), `CRON_INTERVAL_MS`
(default 120000 ≈ the hosted every-2-minutes cron).

**Secrets via files.** Any `FOO_FILE=/run/secrets/foo` is read into `FOO` at startup (Docker/Compose
secrets, multi-line keys) — an explicit `FOO` always wins.

---

## 4. AI provider (optional)

Without an AI provider the review still runs fully — deterministic signals, the gate, merge/close decisions —
and only the AI **summary** degrades to "unavailable". To enable AI, set `AI_PROVIDER`:

| `AI_PROVIDER`                             | Backend                                                                                                                                   | Extra config                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ollama`                                  | local Ollama `/v1` endpoint                                                                                                               | `OLLAMA_AI_BASE_URL`, `OLLAMA_AI_MODEL`, optional `OLLAMA_AI_API_KEY`                                                         |
| `openai-compatible`                       | any OpenAI-compatible `/chat/completions` endpoint (Groq, Together, OpenRouter, vLLM, Gemini's OpenAI-compat endpoint, …)                | `OPENAI_COMPATIBLE_AI_BASE_URL`, `OPENAI_COMPATIBLE_AI_MODEL`, optional `OPENAI_COMPATIBLE_AI_API_KEY`                       |
| `openai`                                  | OpenAI API `/v1` endpoint                                                                                                                 | `OPENAI_API_KEY`, `OPENAI_AI_MODEL`, optional `OPENAI_AI_BASE_URL`                                                            |
| `anthropic`                               | **native Anthropic Messages API** (BYOK — bills your API key)                                                                             | `ANTHROPIC_API_KEY`, `ANTHROPIC_AI_MODEL`, optional `ANTHROPIC_AI_BASE_URL`                                                   |
| `claude-code`                             | your **Claude** subscription via the `claude` CLI (read-only, headless)                                                                   | `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_AI_MODEL`, `CLAUDE_AI_EFFORT`, `CLAUDE_AI_TIMEOUT_MS`                                      |
| `codex`                                   | your **Codex** subscription via the `codex` CLI                                                                                           | local `codex` auth, `CODEX_AI_MODEL`, `CODEX_AI_EFFORT`, `CODEX_AI_TIMEOUT_MS`                                                |

**Review timeout.** `CLAUDE_AI_TIMEOUT_MS` and `CODEX_AI_TIMEOUT_MS` override the subscription-CLI subprocess
timeout. Left unset, the timeout scales with the matching provider effort so large reviews are not SIGKILLed
mid-generation. Overrides are clamped to 30s-30min.

**Fallback chain.** `AI_PROVIDER` accepts a comma-separated list and tries each in order until one succeeds —
e.g. `AI_PROVIDER=anthropic,ollama` uses the Anthropic API first and falls back to a local Ollama model if it
errors. If every provider fails, the AI summary degrades to "unavailable" and the review still runs.

**Dual review (consensus / synthesis).** With **two** providers, `AI_PROVIDER=claude-code,codex` runs _both_ as
independent reviewers and combines them per `AI_COMBINE` (#dual-ai-combiner):

| `AI_COMBINE`                    | Decision                                                                          | Notes                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `single`                        | one reviewer's verdict (auto when only one provider)                              | a named blocker blocks                                                          |
| `consensus`                     | block only when **both** flag a critical defect; lone flag → **hold** for a human | most conservative                                                               |
| `synthesis` _(default for two)_ | both review, then **one merged decision**                                         | `AI_ON_MERGE=either` blocks if either flags (default), `both` only when both do |

In `block` mode the combined decision drives the gate; in `advisory` mode it's notes only. Every strategy is
fail-closed — if a reviewer can't return a usable verdict, the PR is **held** for a human, never auto-merged. The
free Cloudflare Workers-AI pair remains the cloud default (`consensus`) — these knobs are for self-host providers.

**Subscription CLIs in the image.** The official/prebuilt image and the default Compose build include the
`claude-code` / `codex` provider CLIs. Provider choice and credentials stay runtime-only: set
`AI_PROVIDER=claude-code`, `AI_PROVIDER=codex`, or a dual pair such as `AI_PROVIDER=claude-code,codex`, then provide
`CLAUDE_CODE_OAUTH_TOKEN` / codex auth at run time. No credentials are baked in. Set `INSTALL_AI_CLIS=false` only for
a custom minimal local build that will never use the subscription CLI providers.

- **Claude Code:** set `CLAUDE_CODE_OAUTH_TOKEN` (a 1-year token from `claude setup-token`, run once in a real
  terminal — it's browser-interactive and prints the token; it has no headless mode). The provider forces the
  subscription token (it scrubs `ANTHROPIC_API_KEY`), so an API key won't be used here — use `AI_PROVIDER=anthropic`
  for API-key billing. The model defaults to `claude-sonnet-4-6` and the reasoning **effort** to `high` (a
  substantive review, not a fast shallow one); override with `CLAUDE_AI_MODEL` (any `claude`-CLI model id or alias,
  e.g. `sonnet`, `opus`, `claude-opus-4-8`) and `CLAUDE_AI_EFFORT` (`low`|`medium`|`high`|`xhigh`|`max`; the CLI
  clamps a level above the model's own ceiling).
- **Codex (ChatGPT subscription).** Mount the Codex home at `/data/codex`, leave `CODEX_HOME` unset, and opt in with
  `GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1` only on an isolated maintainer deployment. Set
  `CODEX_AI_MODEL=gpt-5.5` and `CODEX_AI_EFFORT=high` for repeatable Codex reviews. The stack uses Codex standard
  speed by default; it does not request the fast/priority service tier.

**Local RAG (retrieval-augmented review).** Self-host ships a SQLite-backed vector store, so RAG works without
Cloudflare Vectorize. Enable it with `GITTENSORY_REVIEW_RAG=true` + the repo in `GITTENSORY_REVIEW_REPOS`, and
point at an **embedding-capable** OpenAI-compatible provider (Ollama) with a **1024-dimensional** model via
`AI_EMBED_MODEL` (e.g. `bge-m3` or `mxbai-embed-large`). Embeddings + chunk vectors are stored in the same
SQLite DB (`_selfhost_vectors`) and queried by cosine similarity. Without an embedding model, RAG degrades to
no-context (the review still runs).

The local-AI default is Ollama: uncomment the `ollama` service in `docker-compose.yml`, set
`AI_PROVIDER=ollama` + `OLLAMA_AI_BASE_URL=http://ollama:11434/v1`, then `docker compose exec ollama ollama pull
<model>`.

**Subscription safety.** The CLI providers run as a read-only subprocess with billable API keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) **scrubbed from the child environment** so a misconfigured CLI
can't silently bill the metered API instead of your subscription. Any error, empty output, or Claude-Code
`is_error` envelope makes the call throw, so the review degrades rather than surfacing an error string as the
model's answer. (Codex is gated/unverified — treat it as best-effort.)

---

## 5. Review modes — advisory vs. full maintainer

Self-host runs the identical engine, so the behavior is configured exactly as on the hosted product:

- **Advisory (default).** With Contents write withheld (or autonomy off), Gittensory posts its unified review
  comment and check, but never merges or closes — a recommendation engine.
- **Full maintainer.** Grant Contents write and enable per-repo autonomy (merge / close / approve) — the bot
  acts on its decisions, gated by the same guardrails (protected-path manual-review globs, owner-PR
  no-auto-close, mergeability + green-CI before approve).

Per-PR capabilities (safety scan, CI/full-file grounding, RAG, unified comment, content lane, self-tune,
parity audit) are the `GITTENSORY_REVIEW_*` flags — every flag defaults **off** and is fully inert until
turned on. Per-repo settings (autonomy, required approvals, protected paths) live in `.gittensory.yml` /
repository settings. The authoritative reference for all of these is
[`docs/review-configuration.md`](./review-configuration.md).

**Container-private per-repo config (keep policy off the public repo).** `.gittensory.yml` lives in the repo, so
contributors can read it — and whoever can see the gate thresholds, autonomy, or label policy can game them. To
keep review policy private, set **`GITTENSORY_REPO_CONFIG_DIR`** to a mounted directory and configure each repo
there. For a repo `JSONbored/gittensory` the engine looks, in priority order, for:

```
$GITTENSORY_REPO_CONFIG_DIR/
├── jsonbored__gittensory/.gittensory.yml   # 1. owner-qualified folder (collision-safe across owners)
├── gittensory/.gittensory.yml              # 2. bare repo-name folder (clean, human-readable)
├── jsonbored__gittensory.yml               # 3. flat owner__repo file (original layout; still supported)
└── .gittensory.yml                         # 4. GLOBAL fallback: applied to every repo without its own file
```

The first match wins outright (a per-repo file fully **replaces** the global fallback — it is a fallback, not a
merge). When any of these exists the engine reads it **instead of** fetching the public `.gittensory.yml`, so the
policy never appears in contributor-facing previews. It uses the same schema (`gate:` / `settings:` / `review:` —
autonomy, labels, model/effort, and `gate.aiReview.allAuthors` to review every PR's author, not only confirmed
contributors), is read fresh each review (edits apply immediately), and `.yaml` / `.json` are accepted everywhere.
Names are lowercased (`/` → double underscore). Unset ⇒ the public file is fetched exactly as before.

**Per-repo converged-feature toggles (`features:`).** Turn individual converged review features on/off per repo:

```yaml
features:
  rag: true # codebase-RAG retrieval context for the reviewer
  reputation: false # internal submitter-reputation AI-spend gate
  unifiedComment: true # render the converged unified PR comment (vs the legacy panel)
  safety: true # defang untrusted PR text before the model sees it
```

Each feature's global env flag (`GITTENSORY_REVIEW_*`) remains a **master kill-switch** — a feature listed here only
runs when its env flag is also on. When a feature is unset in `features:`, it falls back to the `GITTENSORY_REVIEW_REPOS`
allowlist (the pre-existing default), so repos that set nothing are unaffected. (grounding, screenshots, and
content-lane are not yet per-repo toggleable and stay on the allowlist.)

---

## 6. Operations

- **Endpoints.**
  - `GET /health` — binding-free liveness (the container `HEALTHCHECK` uses it).
  - `GET /ready` — readiness: returns `503` until the DB answers **and** migrations are applied
    (`{"ok":true,"checks":{"db":true,"migrations":true}}`). Use it as your orchestrator's readiness probe.
  - `GET /metrics` — Prometheus text: `gittensory_queue_pending` / `_dead`, `gittensory_jobs_*_total`
    (enqueued/processed/failed/dead), `gittensory_uptime_seconds`, `gittensory_http_requests_total`.
- **Durable queue.** Jobs are persisted in SQLite (`_selfhost_jobs`), not held in memory — a restart or crash
  **re-claims** in-flight work instead of losing it. Failures retry with exponential backoff and dead-letter
  after `maxRetries` (visible via `gittensory_queue_dead`).
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server stops accepting requests, lets the queue finish its
  in-flight job, checkpoints the WAL, and closes the DB before exiting.
- **Logs** are structured JSON (`selfhost_listening`, `selfhost_migrations_applied`, `selfhost_ai_provider`,
  `selfhost_queue_recovered`, `selfhost_job_dead`, `selfhost_cron_error`, `selfhost_shutdown`, …).
- **Sentry error tracking.** Set `SENTRY_DSN` (or mount `SENTRY_DSN_FILE`) to capture self-host runtime errors.
  Keep `SENTRY_ENVIRONMENT=selfhost`. The SDK release is `SENTRY_RELEASE` when set, otherwise the baked
  `GITTENSORY_VERSION` value. Official release images bake `GITTENSORY_VERSION=gittensory-selfhost@<version>`;
  the release workflow builds `dist/server.mjs`, injects/uploads matching Sentry source maps, then builds the
  runtime image from that injected bundle. Custom images should set `SENTRY_RELEASE` only when you uploaded source
  maps for that exact bundle under that exact release id.
- **Data + backup.** Everything is the single SQLite file on the `gittensory-data` volume (WAL mode). Back up
  by snapshotting the volume or copying the `.sqlite` file. Migrations are idempotent and re-checked at boot.
  For **continuous, point-in-time backup**, enable the optional [Litestream](https://litestream.io) sidecar in
  `docker-compose.yml` (copy `litestream.yml.example` → `litestream.yml`, set your bucket + credentials); it
  streams every change to S3/B2/MinIO/R2.
- **Maintainer Grafana dashboards.** Grafana does **not** mount the live app database. The observability profile
  starts `reporting-exporter`, which projects the active `pull_requests` + latest `advisories` rows into a
  dashboard-safe `review_targets` snapshot, preserves older non-overlapping legacy `review_targets`, and copies
  redacted `ai_usage_events` rows into `/reporting/gittensory-reporting.sqlite` every
  `GRAFANA_REPORTING_EXPORT_INTERVAL_SECONDS` seconds (default 30). The SQLite datasource points at that redacted
  reporting DB. If you override the app SQLite `DATABASE_PATH`, set `GITTENSORY_REPORTING_SOURCE_DB` to the
  matching exporter mount path, for example `/appdb/custom.sqlite` for `DATABASE_PATH=/data/custom.sqlite`.
  `DATABASE_URL`/Postgres deployments currently export an empty dashboard-safe DB so Grafana can start;
  Postgres-backed maintainer analytics need a dedicated SQL exporter.
- **App-level metrics.** Enable `GITTENSORY_REVIEW_OPS=true` for the read-only gate-block anomaly scan and the
  bearer-gated `GET /v1/internal/ops/stats` aggregate.

### Sentry source maps and release tracking

This repo is not required to publish an official image on every self-host tweak. The source-map upload path is only
wired into the maintainer release workflow (`selfhost-v*` tags or manual `release-selfhost` runs), so normal PRs and
local operator builds do not upload anything to Sentry and do not need extra commands.

Set the Sentry GitHub code mapping for the Sentry project to:

| Sentry field      | Value |
| ----------------- | ----- |
| Stack Trace Root  | `/app` |
| Source Code Root  | `.`   |
| Branch            | `main` |

The maintainer release workflow expects:

| GitHub setting              | Value                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Secret `SENTRY_AUTH_TOKEN`  | Sentry auth token allowed to create releases and upload source maps    |
| Variable `SENTRY_ORG`       | Sentry organization slug                                              |
| Variable `SENTRY_PROJECT`   | Sentry project slug                                                   |
| Variable `SENTRY_URL`       | Optional Sentry API URL; defaults to `https://sentry.io`               |
| Sentry GitHub integration   | Installed for `JSONbored/gittensory`, with the code mapping above      |

The workflow builds `dist/server.mjs` with `dist/server.mjs.map`, validates the `sourceMappingURL` and embedded
`sourcesContent`, injects Sentry debug ids, creates release `gittensory-selfhost@<version>`, associates commits with
the tagged commit, uploads the source maps with Sentry validation/waiting enabled, finalizes the release, and then
validates through the Sentry API that the exact release exists, is finalized, and includes the release commit. It then
builds the image from that injected `dist/server.mjs`. `dist/server.mjs.map` is **not** copied into the runtime image
and is not served by the app; it only exists as a private Sentry release artifact.

For a custom image, source maps only work when the deployed JS bundle is the exact post-injection bundle whose map was
uploaded. If you build locally and do not upload maps, leave `SENTRY_RELEASE` unset. Events still report to Sentry,
but stack frames can remain bundled at `/app/dist/server.mjs`.

If a new event still shows `/app/dist/server.mjs`:

1. Confirm the event's `release` exactly matches the release that has the uploaded artifact bundle.
2. Confirm the image was built from the injected `dist/server.mjs`, not from a later Docker-internal rebuild.
3. Confirm the Sentry code mapping is `/app` → `.` on branch `main`.
4. Confirm the release workflow's `Validate Sentry release` step passed for that exact `gittensory-selfhost@<version>`.
5. Confirm `dist/server.mjs` had `//# sourceMappingURL=server.mjs.map` before upload and the map includes
   `sourcesContent`.
6. Trigger a fresh event after the upload; old events may need reprocessing before they pick up newly uploaded maps.

---

## 7. Scaling out — Postgres + Redis (multi-instance)

The SQLite default is ideal for a single instance. To run **multiple replicas** behind a load balancer, switch
to a shared Postgres + Redis:

- **`DATABASE_URL=postgres://user:pw@host:5432/db`** — uses Postgres instead of SQLite. The same 56 migrations
  apply (translated to Postgres at startup), and the job queue moves to Postgres with `FOR UPDATE SKIP LOCKED`
  claiming, so replicas never double-process a job.
- **`REDIS_URL=redis://host:6379`** — a shared fixed-window rate limiter across all replicas.

Uncomment the `postgres` + `redis` services in `docker-compose.yml`, set the two URLs on the app service, and
scale (`docker compose up --scale gittensory=3`). Postgres is **beta**: the migrations + the exercised query
paths are validated against a real Postgres, but report any dialect edge cases. RAG (the SQLite vector store)
is **not** available on the Postgres backend yet — it degrades to no-context.

## 8. Cloudflare bindings not used by self-host

The Cloudflare API worker keeps serving the public API + Orb broker. Review execution runs in the Docker stack,
which uses self-host equivalents instead of Cloudflare review bindings:

- **Visual PR capture** — use `INSTALL_VISUAL_REVIEW=true` plus `BROWSER_WS_ENDPOINT`; persist captures with
  `REVIEW_AUDIT_DIR`. Without those, reviews run text-only.
- **The `/mcp` server** (Durable-Object-backed Agents SDK) — returns `501`. The deterministic API + review
  path is unaffected; a native MCP-on-Node port is a follow-up.
- **Distributed rate limiting** — uses Redis through `REDIS_URL` instead of the Cloudflare RateLimiter Durable
  Object.
- **RAG and audit storage** — use Qdrant or the built-in sqlite vector store for RAG, and `REVIEW_AUDIT_DIR`
  for audit/screenshot blobs instead of Cloudflare Vectorize/R2.
