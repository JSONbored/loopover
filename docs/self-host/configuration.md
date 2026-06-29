# Self-host configuration reference

Three layers, highest priority first:

1. **Container-private `.gittensory.yml`** (`GITTENSORY_REPO_CONFIG_DIR`) — per-repo policy that contributors
   can't read or game. **Replaces** the public repo file for that repo.
2. **Public `.gittensory.yml`** in the repo — the same schema, but visible to contributors.
3. **Environment variables** (`.env`) — deploy-wide defaults + feature kill-switches + infrastructure.

## Container-private per-repo config

Set `GITTENSORY_REPO_CONFIG_DIR=/config/repos` and mount a directory. For `JSONbored/gittensory` the engine looks,
in priority order, for:

```
$GITTENSORY_REPO_CONFIG_DIR/
├── jsonbored__gittensory/.gittensory.yml   # 1. owner-qualified folder (collision-safe)
├── gittensory/.gittensory.yml              # 2. bare repo-name folder
├── jsonbored__gittensory.yml               # 3. flat owner__repo file
└── .gittensory.yml                         # 4. GLOBAL fallback for any repo without its own file
```

First match wins (it's a fallback, not a merge). Read fresh each review — **no restart needed** to change per-repo
policy. `.yaml`/`.json` accepted; names lowercased. Unset ⇒ the public file is fetched as normal.

### Schema (the same `gate:` / `settings:` / `review:` / `features:` blocks)

```yaml
gate:
  enabled: true
  aiReview:
    mode: advisory # off | advisory | block
    allAuthors: true # review EVERY author, not only confirmed Gittensor contributors
settings:
  commentMode: all_prs # off | detected_contributors_only | all_prs
  includeMaintainerAuthors: true # review the maintainer's own PRs
  autoLabelEnabled: false
  autonomy: # per-action: observe (no act) | …
    merge: observe
    close: observe
  closeOwnerAuthors:
    false # false (default) = the OWNER's own PRs are exempt from auto-close (merge or
    #   manual-hold only); true = owner PRs are closeable like a contributor's
    #   (still gated by `close` autonomy + adverse signals). Automation bots stay exempt.
  agentDryRun: false # true = suppress ALL writes (no comments/labels/checks) — full dry-run
features: # per-repo converged-feature toggles (see "Feature flags" below)
  rag: true
  reputation: false
  unifiedComment: true
  safety: true
```

The friendly `gate:` block is a typed alias that wins over `settings:` for its fields. Full schema:
[`../review-configuration.md`](../review-configuration.md).

## Feature flags (env kill-switches + per-repo activation)

Each converged feature has a **global env kill-switch**; when on, per-repo activation is decided by the
`features:` block, falling back to the `GITTENSORY_REVIEW_REPOS` allowlist when the manifest says nothing.

| Feature         | Env kill-switch                     | Per-repo key     | What it does                                              |
| --------------- | ----------------------------------- | ---------------- | --------------------------------------------------------- |
| Unified comment | `GITTENSORY_REVIEW_UNIFIED_COMMENT` | `unifiedComment` | One converged PR comment vs the legacy panel              |
| Safety          | `GITTENSORY_REVIEW_SAFETY`          | `safety`         | Defang untrusted PR text + secret scan                    |
| RAG             | `GITTENSORY_REVIEW_RAG`             | `rag`            | Codebase retrieval ([rag-indexing.md](./rag-indexing.md)) |
| Reputation      | `GITTENSORY_REVIEW_REPUTATION`      | `reputation`     | Internal AI-spend gate on burst/low-rep submitters        |
| Grounding       | `GITTENSORY_REVIEW_GROUNDING`       | _(allowlist)_    | Feed finished CI + file contents to the reviewer          |
| Content lane    | `GITTENSORY_REVIEW_CONTENT_LANE`    | _(allowlist)_    | Deterministic registry-surface review                     |
| Ops             | `GITTENSORY_REVIEW_OPS`             | _(global)_       | Anomaly scan + `/v1/internal/ops/stats`                   |
| Selftune        | `GITTENSORY_REVIEW_SELFTUNE`        | _(global)_       | Tightening-only auto-tune learning loop                   |

`GITTENSORY_REVIEW_REPOS` — comma-separated `owner/repo` allowlist; activates allowlist-gated features and is the
default candidate set for RAG indexing.

## AI environment variables

See [ai-providers.md](./ai-providers.md) for the full provider/model/effort/timeout/embed reference. Key ones:

| Var                                          | Purpose                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                                | `claude-code` / `codex` / `anthropic` / `ollama` / … (comma-list = chain/dual-review) |
| `AI_MODEL`, `AI_EFFORT`                      | Model id + intelligence dial (low…max, default high)                                  |
| `AI_TIMEOUT_MS`                              | CLI subprocess timeout override (else scales with effort)                             |
| `CLAUDE_CODE_OAUTH_TOKEN`                    | Claude Code subscription token (`claude setup-token`)                                 |
| `AI_EMBED_BASE_URL` / `_MODEL` / `_PROVIDER` | Dedicated RAG embed provider                                                          |
| `GITTENSORY_REPO_CONFIG_DIR`                 | Container-private per-repo config dir                                                 |

## Sentry environment variables

Sentry is optional and self-host-only. Unset `SENTRY_DSN` means no SDK import, no events, and no runtime overhead.

| Var                         | Purpose                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                | Enables self-host error reporting. Keep it in `.env` or a mounted secret.                                                                     |
| `SENTRY_ENVIRONMENT`        | Environment name, default `production`.                                                                                                       |
| `SENTRY_TRACES_SAMPLE_RATE` | Trace sampling, default `0`; errors still report when tracing is off.                                                                         |
| `SENTRY_RELEASE`            | Custom images only, and only when source maps for that exact built bundle were uploaded under the same release id.                             |
| `GITTENSORY_VERSION`        | Baked into future official images as `gittensory-selfhost@<version>` and used as the Sentry release when `SENTRY_RELEASE` is not explicitly set. |

## Secrets — never commit them

`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `INTERNAL_JOB_TOKEN`, `TOKEN_ENCRYPTION_SECRET`,
`SENTRY_DSN`, the App private key, and the webhook secret live in `.env` / mounted files **only** — keep your
deploy directory out of any repo.
