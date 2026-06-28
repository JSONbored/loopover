# AI providers, models, effort & cost

The reviewer is configured by `AI_PROVIDER`. Reviews degrade deterministically (no AI) if it's unset.

## Providers

| `AI_PROVIDER`                             | Backend                                                                 | Needs                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `claude-code`                             | Your **Claude** subscription via the `claude` CLI (read-only, headless) | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`); CLI baked in (`INSTALL_AI_CLIS=true`) |
| `codex`                                   | Your **Codex** subscription via the `codex` CLI                         | local `codex` auth mounted at `/data/codex`, CLI baked in, explicit unsafe opt-in       |
| `anthropic`                               | Native **Anthropic API** (BYOK, per-token billing — no weekly limit)    | `ANTHROPIC_API_KEY`, `ANTHROPIC_AI_MODEL`                                               |
| `ollama` / `openai-compatible` / `openai` | Any OpenAI-compatible `/chat/completions` (+ `/embeddings`)             | provider-specific `*_AI_BASE_URL`, `*_AI_API_KEY`, `*_AI_MODEL`                         |

**Chain / fallback:** `AI_PROVIDER` accepts a comma list, tried in order until one succeeds — e.g.
`AI_PROVIDER=anthropic,ollama`. **Dual review:** two providers (`claude-code,codex`) run as independent reviewers
combined per `AI_COMBINE` (`single`/`consensus`/`synthesis`).

> The chat-only CLIs (`claude`, `codex`) **reject embedding requests**, so in a chain the embed call routes through
> to an embed-capable provider — they never silently swallow embeddings. For RAG use a _dedicated_ embed provider
> (`AI_EMBED_*`) so reviews stay frontier-only; see [rag-indexing.md](./rag-indexing.md).

## Model & effort (the intelligence dial)

| Var                          | Default                        | Notes                                                                                 |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `CLAUDE_AI_MODEL`            | `claude-sonnet-4-6`            | Any `claude` CLI model id/alias.                                                      |
| `CLAUDE_AI_EFFORT`           | `high`                         | `low \| medium \| high \| xhigh \| max` -> `claude --effort`.                         |
| `CLAUDE_AI_TIMEOUT_MS`       | scales with `CLAUDE_AI_EFFORT` | Unset -> low/med 120s, high 240s, xhigh 360s, max 600s. Override clamped 30s-30min.   |
| `CODEX_AI_MODEL`             | Codex account default          | Set to `gpt-5.5` for repeatable Codex reviews.                                        |
| `CODEX_AI_EFFORT`            | `high`                         | `low \| medium \| high \| xhigh`; `max` maps to `xhigh`.                              |
| `CODEX_AI_TIMEOUT_MS`        | scales with `CODEX_AI_EFFORT`  | Unset -> low/med 120s, high 240s, xhigh 360s. Override clamped 30s-30min.             |
| `OLLAMA_AI_MODEL`            | `llama3.1`                     | Used only by `AI_PROVIDER=ollama`.                                                    |
| `OPENAI_COMPATIBLE_AI_MODEL` | `llama3.1`                     | Used only by `AI_PROVIDER=openai-compatible`.                                         |
| `OPENAI_AI_MODEL`            | `gpt-5.5`                      | Used only by `AI_PROVIDER=openai`; override for a different OpenAI model.             |
| `ANTHROPIC_AI_MODEL`         | `claude-sonnet-4-6`            | Used only by `AI_PROVIDER=anthropic`.                                                 |

## Codex subscription reviewer

Codex is intentionally disabled until the operator opts in with
`GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1`. The risk is specific: `codex exec` needs an OAuth
`auth.json`, and a prompt-influenced read-only review sandbox can still read files. On an isolated
maintainer deployment, mount the Codex home at `/data/codex`; the image exposes that as the default
`~/.codex` path for the `node` user. Do not set `CODEX_HOME` in the app environment. The provider
rejects `CODEX_HOME` so the credential path is not advertised to the subprocess through env.
Set `CODEX_AI_MODEL=gpt-5.5` and `CODEX_AI_EFFORT=high` for the current recommended Codex reviewer.
The stack uses Codex standard speed by default; it does not request the fast/priority service tier.

## Cost & usage observability

Every provider's token/cost usage is captured and exported to Prometheus — surfaced in the **AI Usage & Cost**
row of the Grafana dashboard (`:3000`):

| Metric                                                      | Labels                          | Meaning                                                          |
| ----------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `gittensory_ai_requests_total`                              | `provider, model, effort`       | Successful subscription-CLI review calls                         |
| `gittensory_ai_input_tokens_total` / `_output_tokens_total` | `provider, model, kind, effort` | Token volume per provider/model when the CLI reports it          |
| `gittensory_ai_total_tokens_total`                          | `provider, model, effort`       | Total token count when the CLI reports it                        |
| `gittensory_ai_cost_usd_total`                              | `provider`                      | Cumulative USD when the CLI reports a cost field                 |

`kind` is `review` for the subscription-CLI review path. Claude Code also exports its own OTEL metrics when
`CLAUDE_CODE_ENABLE_TELEMETRY=1`; Codex cost appears only if the CLI emits a cost field.

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
