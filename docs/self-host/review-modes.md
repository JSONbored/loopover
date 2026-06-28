# Review modes: advisory, dry-run, and live

Two independent dials control how much the engine _says_ vs _does_. Start conservative and open up.

## The two dials

**1. `aiReviewMode`** (per-repo) — how much the AI review can do:

| Mode       | Behaviour                                                                     |
| ---------- | ----------------------------------------------------------------------------- |
| `off`      | No AI review (deterministic panel only).                                      |
| `advisory` | Post AI review notes; **never** a gate blocker.                               |
| `block`    | Also let a dual-model high-confidence consensus defect become a gate blocker. |

**2. `autonomy` / `agentDryRun`** (per-repo) — whether the engine _acts_:

| Setting                                                   | Effect                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `autonomy.{merge,close,approve,request_changes}: observe` | Compute + post the verdict, but **take no GitHub action** (no merge/close/approve).  |
| `agentDryRun: true`                                       | **Suppress all writes** — no comments, labels, checks, or actions. Pure shadow mode. |

## Recommended progression

1. **Index-only / shadow** — build knowledge + watch, post nothing:
   `features.rag: true`, `aiReviewMode: off` or `agentDryRun: true`.
2. **Live advisory** — post real reviews, take no action:
   `aiReviewMode: advisory`, `autonomy.* : observe`. _(This is the safe "show me the reviews" mode.)_
3. **Active** — only when you trust the verdicts: relax `autonomy` per action class.

> A brokered self-host posts as `gittensory-orb`. `commentMode: all_prs` comments on every open PR;
> `includeMaintainerAuthors: true` reviews the maintainer's own PRs (paired with `aiReviewAllAuthors: true`).

## Token-spend guarantees (advisory or not)

- **One AI review per code-state.** The review fires on `opened` / `reopened` / `synchronize` /
  `ready_for_review` / `edited`, but the head SHA is recorded on attempt — so an `edited` or duplicate event on the
  **same commit never re-spends**. A new push (new SHA) gets a fresh review.
- **Sweeps don't re-run the AI** in advisory mode (deterministic re-gate only).
- **Reputation** (when on) skips paid AI on burst / low-reputation submitters.

So "1 review per PR, max" holds even with active contributors — see
[ai-providers.md](./ai-providers.md#token-spend-protection).

## The converged features

When enabled (env kill-switch + per-repo/allowlist activation — see
[configuration.md](./configuration.md#feature-flags-env-kill-switches--per-repo-activation)):

- **safety** — defang untrusted PR text + secret scan before the model sees it.
- **grounding** — feed the reviewer the finished CI status + full changed-file contents (verify, don't guess).
- **rag** — retrieve relevant existing code ([rag-indexing.md](./rag-indexing.md)).
- **reputation** — internal AI-spend gate (never surfaced publicly).
- **unifiedComment** — one converged PR comment instead of the legacy panel.
- **contentLane** — deterministic, AI-free registry-surface review (for registry repos).
- **ops / selftune** — observability + a tightening-only learning loop that improves the gate over time.
