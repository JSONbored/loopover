# Self-host troubleshooting

Real failure modes and their fixes, ordered by how often they bite. Each entry is _symptom → cause → fix_.

> First stop for any "the bot isn't doing X": `docker compose logs gittensory --since 10m` (structured JSON
> logs) and `GET /metrics`. The boot logs (`selfhost_listening`, `selfhost_ai_provider`,
> `selfhost_embed_provider`, `selfhost_vectorize`, `selfhost_migrations_applied`) tell you what's actually wired.

---

## AI reviews never post

### `claude: not found` / `codex: not found` in the container

**Symptom:** zero `ai_review` activity; reviews silently fall back to the deterministic panel.
**Cause:** the CLI subscription providers shell out to the `claude` / `codex` binaries, but the image was built
**without** the AI CLIs.
**Fix:** rebuild with the build arg:

```bash
docker compose build --build-arg INSTALL_AI_CLIS=true gittensory
docker compose up -d --force-recreate gittensory
docker exec gittensory-gittensory-1 sh -c 'which claude && claude --version'
```

### `"You've hit your weekly limit"` (HTTP 429)

**Symptom:** `claude` runs but returns `{"is_error":true,"api_error_status":429}`.
**Cause:** the Claude Code **subscription** quota is exhausted (resets weekly). Auth is fine — it's a quota wall.
**Fix:** swap `CLAUDE_CODE_OAUTH_TOKEN` for an account with remaining quota (`claude setup-token`), or switch to
`AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (per-token billing, no weekly limit), then recreate the container.

### The review only runs for confirmed Gittensor contributors

**Symptom:** PRs from you / non-miners get the panel but no AI review.
**Cause:** the AI review is confirmed-contributor-gated by default (an AI-spend guard).
**Fix:** set `gate.aiReview.allAuthors: true` (or `settings.aiReviewAllAuthors: true`) in the repo's private
`.gittensory.yml`. See [configuration.md](./configuration.md).

### A large `AI_EFFORT=max` review produces nothing

**Symptom:** big PRs silently get no review; small ones work.
**Cause:** the CLI subprocess timed out. (Older builds hard-capped at 120s.)
**Fix:** the timeout now scales with `AI_EFFORT` (max → 600s); override with `AI_TIMEOUT_MS` (clamped 30s–30min).

---

## RAG returns no context / never indexes

### Embeddings fail with the review provider

**Symptom:** `rag_embed_error` logs; the reviewer never gets a "relevant code" section.
**Cause:** Claude/Codex **cannot produce embeddings** — they're chat-only. RAG needs a separate embedding model.
**Fix:** stand up an embed provider and point RAG at it:

```bash
# .env
AI_EMBED_BASE_URL=http://ollama:11434/v1
AI_EMBED_MODEL=bge-m3        # 1024-d, 8192-ctx — the right choice for code
GITTENSORY_REVIEW_RAG=true
QDRANT_URL=http://qdrant:6333
# bring up the services + pull the model
docker compose --profile qdrant --profile ollama up -d qdrant ollama
docker exec gittensory-ollama-1 ollama pull bge-m3
docker compose up -d --force-recreate gittensory
```

Boot should log `selfhost_embed_provider` + `selfhost_vectorize{backend:qdrant}`. See [rag-indexing.md](./rag-indexing.md).

### A configured repo never gets indexed by the cron

**Symptom:** the 6-hourly fan-out indexes nothing for your repos.
**Cause:** in the brokered model your repos are `is_registered=0` (they never went through the registration
webhook), and the fan-out indexes the configured (`GITTENSORY_REVIEW_REPOS`) set as well as registered repos.
**Fix:** make sure the repo is in `GITTENSORY_REVIEW_REPOS` (or has a per-repo `features.rag: true`), then trigger
an immediate index instead of waiting for the cron:

```bash
curl -X POST localhost:8787/v1/internal/jobs/rag-index \
  -H "authorization: Bearer $INTERNAL_JOB_TOKEN" \
  -H "content-type: application/json" -d '{"repoFullName":"owner/repo"}'
```

### Indexing is slow

**Symptom:** the index job runs for many minutes.
**Cause:** CPU embedding (~1 chunk/s on `bge-m3`). It's a **one-time** cost — afterwards only changed files re-index
on merge. Indexing runs on a **dedicated queue lane**, so a slow index never blocks live reviews / webhooks /
sweeps (those drain on the main lane in parallel). Tune index parallelism with `QUEUE_INDEX_CONCURRENCY` (default 1)
and the main lane with `QUEUE_CONCURRENCY`.

---

## Reviews fire too often / token burn

**Symptom:** the same PR seems to get reviewed repeatedly.
**Cause/Fix:** the engine guarantees **one AI review per head SHA** — a `synchronize`/`edited`/duplicate event on
the _same commit_ is deduped (no re-spend); a new push (new SHA) gets a fresh review. The re-gate sweep skips the
AI review entirely in advisory mode. If you still see repeats, check for an automation pushing new commits.

---

## Container / build

### Two migrations with the same number

**Symptom:** `db:migrations:check` fails on a duplicate number after a rebase.
**Fix:** renumber your migration to the next free `NNNN_*.sql` (the check prints `Next free:`).

### `codex` "model not supported when using Codex with a ChatGPT account"

**Cause:** forcing `--model gpt-5-codex` on a ChatGPT-account login fails.
**Fix:** leave `AI_MODEL` unset for codex — it picks the account's own default. (Don't set a Claude model id on a
`claude-code,codex` combo: `AI_MODEL` is global and a Claude id breaks codex.)

### Reviews post as `gittensory-orb`, not your own bot

**Cause:** a brokered self-host borrows tokens from the central Orb App. To post under your own bot identity you
need the own-App (non-brokered) path.

---

## Where to look next

- **Observability:** Grafana at `:3000` (the **AI Usage & Cost** row shows token/model/effort/cost per provider).
- **Health:** `GET /ready` returns 503 until the DB answers and migrations are applied.
- **Config not taking effect:** the container-private `.gittensory.yml` is read fresh each review — no restart
  needed for per-repo config; _env_ changes (`.env`) need `docker compose up -d --force-recreate gittensory`.
