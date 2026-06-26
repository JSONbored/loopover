# Self-hosting Gittensory

Gittensory ships as a Cloudflare Worker, but the **same** review engine runs unchanged on a plain Node
container so you can self-host it on your own infrastructure (Docker, Railway, Fly, a VM …). `docker
compose up` gives you the full reviewer — webhooks, the deterministic gate, AI summaries, the
maintain/sweep cron, and (optionally) full maintainer autonomy — backed by a local SQLite database.

Self-host connects to the **Gittensory Orb** — our central GitHub App that brokers GitHub access and
collects anonymized fleet calibration. This is the **gittensor-Mirror model**: you install the **Orb App**
on your repos and run the container; you **do not create your own GitHub App or manage a private key**, the
Orb relays your repos' events to your container and mints short-lived GitHub tokens on demand, and your
instance contributes anonymized review outcomes that keep the gate calibrated across the whole fleet (and
power the public stats on gittensory.aethereal.dev).

> **How it works (one paragraph).** The Worker's Cloudflare bindings are swapped for self-host adapters and
> nothing else changes: **D1 → `node:sqlite`** (a faithful `D1Database` shim, so Drizzle + every raw query +
> all 56 schema migrations run byte-for-byte the same), **Queue → an in-process FIFO worker** (same
> `processJob`), and the **cron** is a timer that calls the same `scheduled()` handler. The Hono app is served
> with `@hono/node-server`. See [`src/server.ts`](../src/server.ts) and [`src/selfhost/`](../src/selfhost).

---

## 1. Quick start (Orb-brokered)

### Step 1 — Install the Gittensory Orb App

[![Install the Gittensory Orb App](https://img.shields.io/badge/Install-Gittensory%20Orb%20App-1f6feb?style=for-the-badge&logo=github)](https://github.com/apps/gittensory-orb/installations/new)

> **→ [github.com/apps/gittensory-orb](https://github.com/apps/gittensory-orb/installations/new)** — install it on the
> repositories you want reviewed.

The Orb App is a GitHub App **we** run; you don't create one. Installing it lets the Orb deliver your repos'
events to your container and mint short-lived GitHub tokens for it on demand.

### Step 2 — Get your enrollment secret (self-service)

When the install is authorized, GitHub returns you to a Gittensory page that — once we've verified server-side
that you're an **admin of the installed account** — shows your **`ORB_ENROLLMENT_SECRET` once**. Copy it (it
isn't shown again). This is a per-install secret; treat it like a password.

> The secret is **self-issued — zero-touch.** There's no operator step and no credential hand-off: a verified
> admin enrolls their own install on the spot. (Lose it? Re-open the install from GitHub to issue a new one.)

### Step 3 — Configure `.env` and run

```bash
cp .env.example .env
# set in .env:
#   ORB_ENROLLMENT_SECRET=<the secret from step 2>
#   ORB_BROKER_URL=https://gittensory-api.aethereal.dev   # default — the Orb broker + collector
#   PUBLIC_API_ORIGIN=https://<your-host>                 # your container's public URL — MUST be reachable by the Orb
docker compose up --build
curl https://<your-host>/health    # {"status":"ok"}
```

On boot the container creates the SQLite database on the `gittensory-data` volume, applies all migrations
automatically (`{"event":"selfhost_migrations_applied",…}` in the logs), then **registers its relay URL**
(`PUBLIC_API_ORIGIN` + `/v1/orb/relay`) with the Orb. From there the Orb **forwards your install's webhooks**
to the container, HMAC-signed with your enrollment secret — there is **no GitHub webhook to configure**. GitHub
API actions (comment, label, merge, close) use **short-lived installation tokens brokered from the Orb on
demand**, so the container never holds a GitHub App private key.

> **The container must be reachable by the Orb.** `PUBLIC_API_ORIGIN` has to resolve from the public internet
> (the Orb POSTs your events to `PUBLIC_API_ORIGIN/v1/orb/relay`). Put it behind your own TLS / reverse proxy and
> expose port 8787. Confirm `GET /ready` returns `200` once migrations are applied.

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
GitHub Release.

---

## 2. Telemetry — Orb fleet calibration

Self-hosting is a **fleet-telemetry contract**: each instance exports an anonymized, reversal-aware
review-outcome signal to the Orb collector (`ORB_COLLECTOR_URL`, default the hosted collector). This is
what calibrates the gate across the whole self-host fleet and produces the accurate aggregate numbers on
gittensory.aethereal.dev — it is **on by default** once your App is configured.

- **Anonymized.** Repo/PR identifiers are HMAC-hashed with a per-instance secret the collector **never
  holds**, so it can't de-anonymize you. The payload is only `verdict + outcome + reversal + a bucketed
  reason category + cycle time` — **no diffs, no code, no comments, no logins, no commit SHAs**.
- It is part of the broker contract (a brokered instance relies on the Orb for tokens + relay), so it stays on.
  `ORB_ANONYMIZE` (default `true`) controls the hashing.

---

## 3. Configuration

Everything is environment variables — see [`.env.example`](../.env.example) for the annotated list (it holds
**sample placeholders only; never commit a real `.env`** — it is gitignored). The required core secrets for
the **Orb-brokered** path:

| Variable | What it is |
| --- | --- |
| `ORB_ENROLLMENT_SECRET` | your one-time enrollment secret from the install flow (§1, step 2) |
| `ORB_BROKER_URL` | the Orb broker + collector base (default `https://gittensory-api.aethereal.dev`) |
| `PUBLIC_API_ORIGIN` | your container's public base URL — **must be reachable by the Orb relay** |
| `GITTENSOR_REGISTRY_URL` | registry endpoint (or any reachable placeholder if you don't use the registry) |
| `GITTENSORY_API_TOKEN` / `GITTENSORY_MCP_TOKEN` / `INTERNAL_JOB_TOKEN` | bearer tokens — generate your own (`openssl rand -hex 32`) |

(You set **no** `GITHUB_APP_*` secrets — the Orb holds the App key and mints tokens for you on demand.)

Runtime knobs: `PORT` (default 8787), `DATABASE_PATH` (default `/data/gittensory.sqlite`), `CRON_INTERVAL_MS`
(default 120000 ≈ the hosted every-2-minutes cron), `QUEUE_CONCURRENCY` (default 4 — how many I/O-bound review
jobs process at once; raise it to drain bigger PR bursts faster, set `1` for strict serial processing).

**Secrets via files.** Any `FOO_FILE=/run/secrets/foo` is read into `FOO` at startup (Docker/Compose
secrets, multi-line keys) — an explicit `FOO` always wins.

---

## 4. AI provider (optional)

Without an AI provider the review still runs fully — deterministic signals, the gate, merge/close decisions —
and only the AI **summary** degrades to "unavailable". To enable AI, set `AI_PROVIDER`:

| `AI_PROVIDER` | Backend | Extra config |
| --- | --- | --- |
| `ollama` / `openai-compatible` / `openai` | any OpenAI-compatible `/chat/completions` endpoint (Ollama, OpenAI, Groq, Together, OpenRouter, vLLM, Gemini's OpenAI-compat endpoint, …) | `AI_BASE_URL`, `AI_API_KEY` (or `OPENAI_API_KEY`), `AI_MODEL` |
| `anthropic` | **native Anthropic Messages API** (BYOK — bills your API key) | `ANTHROPIC_API_KEY`, `AI_MODEL` (e.g. `claude-sonnet-4-6`) |
| `claude-code` | your **Claude** subscription via the `claude` CLI (read-only, headless) | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `AI_MODEL` (default `claude-sonnet-4-6`), `AI_EFFORT` (default `high`) |
| `codex` | your **Codex** subscription via the `codex` CLI | local `codex` auth, `AI_MODEL` (e.g. `gpt-5`) |

**Fallback chain.** `AI_PROVIDER` accepts a comma-separated list and tries each in order until one succeeds —
e.g. `AI_PROVIDER=anthropic,ollama` uses the Anthropic API first and falls back to a local Ollama model if it
errors. If every provider fails, the AI summary degrades to "unavailable" and the review still runs.

**Dual review (consensus / synthesis).** With **two** providers, `AI_PROVIDER=claude-code,codex` runs *both* as
independent reviewers and combines them per `AI_COMBINE` (#dual-ai-combiner):

| `AI_COMBINE` | Decision | Notes |
|---|---|---|
| `single` | one reviewer's verdict (auto when only one provider) | a named blocker blocks |
| `consensus` | block only when **both** flag a critical defect; lone flag → **hold** for a human | most conservative |
| `synthesis` *(default for two)* | both review, then **one merged decision** | `AI_ON_MERGE=either` blocks if either flags (default), `both` only when both do |

In `block` mode the combined decision drives the gate; in `advisory` mode it's notes only. Every strategy is
fail-closed — if a reviewer can't return a usable verdict, the PR is **held** for a human, never auto-merged. The
free Cloudflare Workers-AI pair remains the cloud default (`consensus`) — these knobs are for self-host providers.

**Subscription CLIs in the image.** The `claude-code` / `codex` providers need their CLI present. Build the
image with `--build-arg INSTALL_AI_CLIS=true` (or `docker compose build --build-arg INSTALL_AI_CLIS=true`) to
bake them in, then provide `CLAUDE_CODE_OAUTH_TOKEN` / codex auth at run time. No credentials are baked in.

- **Claude Code:** set `CLAUDE_CODE_OAUTH_TOKEN` (a 1-year token from `claude setup-token`, run once in a real
  terminal — it's browser-interactive and prints the token; it has no headless mode). The provider forces the
  subscription token (it scrubs `ANTHROPIC_API_KEY`), so an API key won't be used here — use `AI_PROVIDER=anthropic`
  for API-key billing. The model defaults to `claude-sonnet-4-6` and the reasoning **effort** to `high` (a
  substantive review, not a fast shallow one); override with `AI_MODEL` (any `claude`-CLI model id or alias —
  `sonnet`, `opus`, `claude-opus-4-8`, …) and `AI_EFFORT` (`low`|`medium`|`high`|`xhigh`|`max`; the CLI clamps a
  level above the model's own ceiling).
- **Codex:** codex reads `auth.json` from `$CODEX_HOME` (default `~/.codex`) and **must have a WRITABLE home** — it
  refreshes the token in place, so a read-only mount fails with *"Read-only file system"*. Set `CODEX_HOME` to a
  writable path and **copy** your `~/.codex/auth.json` there (don't bind-mount it read-only). With a ChatGPT-
  subscription login, leave `AI_MODEL` unset for codex — pinning `gpt-5*` returns *"not supported … with a ChatGPT
  account"*; codex picks the entitled default. (`ca-certificates` for codex's native TLS is baked in by `INSTALL_AI_CLIS`.)

**Local RAG (retrieval-augmented review).** Self-host ships a SQLite-backed vector store, so RAG works without
Cloudflare Vectorize. Enable it with `GITTENSORY_REVIEW_RAG=true` + the repo in `GITTENSORY_REVIEW_REPOS`, and
point at an **embedding-capable** OpenAI-compatible provider (Ollama) with a **1024-dimensional** model via
`AI_EMBED_MODEL` (e.g. `bge-m3` or `mxbai-embed-large`). Embeddings + chunk vectors are stored in the same
SQLite DB (`_selfhost_vectors`) and queried by cosine similarity. Without an embedding model, RAG degrades to
no-context (the review still runs).

> **Set `AI_MODEL`.** The core would otherwise hand the adapter a Cloudflare Workers-AI model id
> (`@cf/meta/...`) that Ollama / `claude` / `codex` can't use. The adapter ignores that id in favour of
> `AI_MODEL` (falling back to a provider default), so always set `AI_MODEL` to a real model for your provider.
> The `claude`/`codex` CLIs must be installed and authenticated in the runtime (a CLI-bearing image variant
> is a follow-up); without `AI_MODEL` + a working CLI, the call throws and the review degrades.

The local-AI default is Ollama: uncomment the `ollama` service in `docker-compose.yml`, set
`AI_PROVIDER=ollama` + `AI_BASE_URL=http://ollama:11434/v1`, then `docker compose exec ollama ollama pull
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

- **Quiet inline comments (CodeRabbit-style).** Set `GITTENSORY_REVIEW_INLINE_COMMENTS=true` + the repo in
  `GITTENSORY_REVIEW_REPOS` + `review.inline_comments: true` in the repo's config, and on top of the decision
  summary the reviewer leaves **non-blocking** inline comments on changed lines (`event: COMMENT`) — useful even
  in advisory mode, telling a contributor exactly what to fix for their next submission. Out-of-diff findings are
  dropped (never a 422), and a failure never affects the gate.

Per-PR capabilities (safety scan, CI/full-file grounding, RAG, unified comment, inline comments, content lane,
self-tune, parity audit) are the `GITTENSORY_REVIEW_*` flags — every flag defaults **off** and is fully inert until
turned on. Per-repo settings (autonomy, required approvals, protected paths) live in `.gittensory.yml` /
repository settings. The authoritative reference for all of these is
[`docs/review-configuration.md`](./review-configuration.md).

**Container-private per-repo config (keep policy off the public repo).** `.gittensory.yml` lives in the repo, so
contributors can read it — and whoever can see the gate thresholds, autonomy, or label policy can game them. To
keep review policy private, set **`GITTENSORY_REPO_CONFIG_DIR`** to a mounted directory and drop one file per repo
named `{owner}__{repo}.yml` (lowercased, `/` → double underscore) — e.g. `jsonbored__metagraphed.yml`. When a file
exists for a repo the engine reads it **instead of** fetching the public `.gittensory.yml`, so the policy never
appears in contributor-facing previews. It uses the same schema (`gate:` / `settings:` / `review:` — autonomy,
labels, model/effort), is read fresh each review (edits apply immediately), and `.yaml` / `.json` are also
accepted. Unset ⇒ the public file is fetched exactly as before.

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
- **Data + backup (do NOT skip).** Everything is the single SQLite file on the `gittensory-data` volume (WAL
  mode), so **without a backup, losing the volume loses all review state** — and `/ready` still answers `200`,
  so the gap is silent. The container logs a loud `selfhost_backup_advisory` warning at boot until you set up a
  backup. For **continuous, point-in-time backup**, enable the [Litestream](https://litestream.io) sidecar in
  `docker-compose.yml` (copy `litestream.yml.example` → `litestream.yml`, set your bucket + credentials); it
  streams every change to S3/B2/MinIO/R2. Then set **`BACKUP_ACKNOWLEDGED=true`** to silence the warning. (For
  multi-instance, use `DATABASE_URL=postgres://…` and back up Postgres instead.)
- **App-level metrics.** Enable `GITTENSORY_REVIEW_OPS=true` for the read-only gate-block anomaly scan and the
  bearer-gated `GET /v1/internal/ops/stats` aggregate.

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

## 8. What is not on self-host

These are Cloudflare-platform features; they degrade cleanly and the core reviewer is unaffected:

- **Visual PR capture** — off by default (reviews run text-only). To enable on self-host: point
  `BROWSER_WS_ENDPOINT` at a browserless/chrome sidecar **and** set `REVIEW_AUDIT_DIR` so captured screenshots
  persist (an fs-backed store standing in for the cloud's R2 bucket); without `REVIEW_AUDIT_DIR` captures degrade
  to on-demand re-render.
- **Distributed rate limiting** (RateLimiter Durable Object) — off by default; set `REDIS_URL` for a
  Redis-backed fixed-window limiter (see §7). Otherwise put a reverse proxy / WAF in front.
- **Vectorize-backed RAG** and **R2 audit storage** — inert unless you wire equivalent backends.
