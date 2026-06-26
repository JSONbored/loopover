# AI providers, models, effort & cost

The reviewer is configured by `AI_PROVIDER`. Reviews degrade deterministically (no AI) if it's unset.

## Providers

| `AI_PROVIDER`                             | Backend                                                                 | Needs                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `claude-code`                             | Your **Claude** subscription via the `claude` CLI (read-only, headless) | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`); CLI baked in (`INSTALL_AI_CLIS=true`) |
| `codex`                                   | Your **Codex** subscription via the `codex` CLI                         | local `codex` auth (mounted), CLI baked in                                              |
| `anthropic`                               | Native **Anthropic API** (BYOK, per-token billing — no weekly limit)    | `ANTHROPIC_API_KEY`, `AI_MODEL`                                                         |
| `ollama` / `openai-compatible` / `openai` | Any OpenAI-compatible `/chat/completions` (+ `/embeddings`)             | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`                                                 |

**Chain / fallback:** `AI_PROVIDER` accepts a comma list, tried in order until one succeeds — e.g.
`AI_PROVIDER=anthropic,ollama`. **Dual review:** two providers (`claude-code,codex`) run as independent reviewers
combined per `AI_COMBINE` (`single`/`consensus`/`synthesis`).

> The chat-only CLIs (`claude`, `codex`) **reject embedding requests**, so in a chain the embed call routes through
> to an embed-capable provider — they never silently swallow embeddings. For RAG use a _dedicated_ embed provider
> (`AI_EMBED_*`) so reviews stay frontier-only; see [rag-indexing.md](./rag-indexing.md).

## Model & effort (the intelligence dial)

| Var             | Default            | Notes                                                                                                                                                |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_MODEL`      | provider default   | e.g. `claude-sonnet-4-6`. **Leave unset on a `claude-code,codex` combo** — it's global and a Claude id breaks codex's account default.               |
| `AI_EFFORT`     | `high`             | `low \| medium \| high \| xhigh \| max` → `claude --effort`. The engine wants substance, not speed.                                                  |
| `AI_TIMEOUT_MS` | scales with effort | Subprocess timeout. Unset ⇒ low/med 120s, high 240s, xhigh 360s, **max 600s** (so a big max-effort review isn't killed). Override clamped 30s–30min. |

## Cost & usage observability

Every provider's token/cost usage is captured and exported to Prometheus — surfaced in the **AI Usage & Cost**
row of the Grafana dashboard (`:3000`):

| Metric                                                      | Labels                          | Meaning                                                          |
| ----------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `gittensory_ai_requests_total`                              | `provider, model, kind, effort` | Review/embed calls (the intelligence dial is the `effort` label) |
| `gittensory_ai_input_tokens_total` / `_output_tokens_total` | `provider, model, kind`         | Token volume per provider/model                                  |
| `gittensory_ai_cost_usd_total`                              | `provider`                      | Cumulative USD (from Claude Code's `total_cost_usd`)             |

`kind` is `chat` (reviews) or `embed` (RAG). The embed provider's label is `AI_EMBED_PROVIDER` (default `ollama`).

## Token-spend protection

- **One AI review per code-state** — re-triggers on the same commit (`edited`, duplicate deliveries, redundant
  `synchronize`) are deduped; only a new push (new head SHA) spends again.
- **Re-gate sweeps skip the AI review** in advisory mode (deterministic re-gate only).
- **Reputation** (when on) skips paid AI on burst/low-reputation submitters.

## Getting / rotating the Claude token

```bash
claude setup-token        # mint a long-lived token (log in with the account that has quota)
```

Put it in `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, then `docker compose up -d --force-recreate gittensory`. A `429`
("weekly limit") means the subscription quota is spent — swap accounts or use `AI_PROVIDER=anthropic` (per-token).
