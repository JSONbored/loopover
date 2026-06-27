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
GitHub Release.

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
| `ollama` / `openai-compatible` / `openai` | any OpenAI-compatible `/chat/completions` endpoint (Ollama, OpenAI, Groq, Together, OpenRouter, vLLM, Gemini's OpenAI-compat endpoint, …) | `AI_BASE_URL`, `AI_API_KEY` (or `OPENAI_API_KEY`), `AI_MODEL`                                                                 |
| `anthropic`                               | **native Anthropic Messages API** (BYOK — bills your API key)                                                                             | `ANTHROPIC_API_KEY`, `AI_MODEL` (e.g. `claude-sonnet-4-6`)                                                                    |
| `claude-code`                             | your **Claude** subscription via the `claude` CLI (read-only, headless)                                                                   | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `AI_MODEL` (default `claude-sonnet-4-6`), `AI_EFFORT` (default `high`) |
| `codex`                                   | your **Codex** subscription via the `codex` CLI                                                                                           | local `codex` auth, `AI_MODEL` (e.g. `gpt-5`)                                                                                 |

**Review timeout (`AI_TIMEOUT_MS`).** The `claude` / `codex` subprocess timeout. Left unset it **scales with
`AI_EFFORT`** (low/medium 120s, high 240s, xhigh 360s, max 600s) so a large `max`-effort review isn't SIGKILLed
mid-generation — the old fixed 120s cap silently dropped long reviews. Set `AI_TIMEOUT_MS` to override (clamped
30s–30min).

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
  refreshes the token in place, so a read-only mount fails with _"Read-only file system"_. Set `CODEX_HOME` to a
  writable path and **copy** your `~/.codex/auth.json` there (don't bind-mount it read-only). With a ChatGPT-
  subscription login, leave `AI_MODEL` unset for codex — pinning `gpt-5*` returns _"not supported … with a ChatGPT
  account"_; codex picks the entitled default. (`ca-certificates` for codex's native TLS is baked in by `INSTALL_AI_CLIS`.)

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
- **Data + backup.** Everything is the single SQLite file on the `gittensory-data` volume (WAL mode). Back up
  by snapshotting the volume or copying the `.sqlite` file. Migrations are idempotent and re-checked at boot.
  For **continuous, point-in-time backup**, enable the optional [Litestream](https://litestream.io) sidecar in
  `docker-compose.yml` (copy `litestream.yml.example` → `litestream.yml`, set your bucket + credentials); it
  streams every change to S3/B2/MinIO/R2.
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

- **Visual PR capture** (Browser Rendering binding) — off; reviews run text-only.
- **The `/mcp` server** (Durable-Object-backed Agents SDK) — returns `501`. The deterministic API + review
  path is unaffected; a native MCP-on-Node port is a follow-up.
- **Distributed rate limiting** (RateLimiter Durable Object) — off by default; set `REDIS_URL` for a
  Redis-backed fixed-window limiter (see §7). Otherwise put a reverse proxy / WAF in front.
- **Vectorize-backed RAG** and **R2 audit storage** — inert unless you wire equivalent backends.
