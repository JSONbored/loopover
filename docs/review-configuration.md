# Gittensory Review Configuration Reference

This is the operator reference for tuning **gittensory CI** and **gittensory review** — the
PR-review engine that scores, gates, and comments on pull requests.

## How configuration works

Gittensory review is built in three layers, and you tune it without touching the review algorithm
itself:

1. **The review algorithm is open-source.** The deterministic gate, the scoring signals, the slop
   detector, the grounding/RAG context builders, and the comment renderer all live in the public
   source tree. Anyone can read exactly how a verdict is reached.

2. **Operators tune via two private, repo-scoped controls** that sit *on top* of the open algorithm:
   - **Per-repo settings** — stored in the operator's database (set through the dashboard/API), or
     declared as config-as-code in a repo's `.gittensory.yml`. These choose gate modes, score
     thresholds, guardrails, and which surfaces are enabled. They never reveal review *direction*,
     so a contributor cannot read them and game the gate.
   - **Operator feature flags** — the `GITTENSORY_REVIEW_*` family of environment variables on the
     worker. These switch whole *capabilities* (safety scanning, CI/full-file grounding, RAG
     context, reputation-based spend control, observability, self-tuning, the unified comment, the
     content lane, the draft-submission flow) on or off for the whole deployment.

3. **Defaults are safe and conservative.** Every feature flag ships **OFF**. A repo with no settings
   row and no `.gittensory.yml` falls back to a quiet, non-blocking profile: the gate is `off`, AI
   review is `off`, slop scoring is `off`, comments are posted only to detected contributors, and no
   check-run is published. Turning anything on is always an explicit opt-in. You roll capabilities
   forward (and back) one flag — and one repo — at a time.

**Precedence (most specific wins):** `.gittensory.yml` in the repo **>** per-repo database settings
**>** built-in safe defaults. The friendly `gate:` block in `.gittensory.yml` is a typed alias for
the gate-related fields and wins over the generic `settings:` block for those same fields.

---

## 1. Feature flags (`GITTENSORY_REVIEW_*`)

These are worker environment variables (declared in `wrangler.jsonc` `vars`, overridable per
deployment). **Every flag defaults to OFF.** "Truthy" means one of `1`, `true`, `yes`, or `on`
(case-insensitive); anything else — including unset, empty, or `false` — is OFF. When a flag is OFF,
its code path is inert: the review behaves exactly as if the feature did not exist (no extra GitHub
fetch, no extra DB read/write, no extra branch taken).

Two flags act as **scopes** rather than capabilities: `GITTENSORY_REVIEW_REPOS` is a per-repo
allowlist that must *also* pass for any of the per-PR features below to run on a given repo. So a
per-PR feature activates only when **(its own flag is ON) AND (the repo is allowlisted)**.

| Flag | What it does | Default | How to tune | Sample |
| --- | --- | --- | --- | --- |
| `GITTENSORY_REVIEW_REPOS` | **Per-repo cutover allowlist.** Comma-separated `owner/repo` names that may run the per-PR review features (`SAFETY`, `GROUNDING`, `RAG`, `REPUTATION`, `UNIFIED_COMMENT`, `INLINE_COMMENTS`). A per-PR feature runs on a repo only if its global flag is ON **and** the repo is listed here. Empty/unset = **no repos** → every per-PR feature stays dormant for everyone regardless of the global flags. Cron/endpoint flags (`OPS`, `SELFTUNE`, `PARITY_AUDIT`, `CONTENT_LANE`, `DRAFT`) are **not** scoped by this. | `""` (no repos) | Add repos one at a time as you roll forward; remove to roll back. Case-insensitive, trimmed; stray commas are ignored. | `"JSONbored/gittensory,JSONbored/awesome-claude"` |
| `GITTENSORY_REVIEW_SAFETY` | **Safety scan** in the review path: (1) defangs untrusted PR title/body/diff (prompt-injection neutralization) before the AI reviewer sees it, and (2) scans the PR diff for leaked secrets, surfacing a `secret_leak` blocker. Per-PR — also requires the repo to be in `GITTENSORY_REVIEW_REPOS`. | `false` | Flip to `true`, then add the repo to `GITTENSORY_REVIEW_REPOS`. No per-repo tuning beyond that. | `"true"` |
| `GITTENSORY_REVIEW_GROUNDING` | **Grounds** the AI-reviewer prompt with the PR's *finished* CI status + the *full post-change content* of the changed files, so a non-frontier model verifies its claims against reality instead of predicting CI or flagging symbols defined just outside the hunk. Per-PR — also gated by `GITTENSORY_REVIEW_REPOS`. | `false` | Flip to `true` + allowlist the repo. Both grounding inputs (CI + full files) are gathered together; there is no partial mode. | `"true"` |
| `GITTENSORY_REVIEW_RAG` | **Retrieval-augmented context.** At review time, queries the codebase vector index for code/docs semantically related to the changed files (callers, related modules, existing conventions) and appends a "Relevant existing code / docs" section to the reviewer prompt — additive only, like grounding. Per-PR — also gated by `GITTENSORY_REVIEW_REPOS`. **Inert until a vector index exists** for the repo (a cold/missing index degrades to no context). | `false` | Flip to `true` + allowlist the repo **and** populate the self-host vector backend (`QDRANT_URL` or the built-in sqlite vector store). Without an index it is a safe no-op. | `"true"` |
| `GITTENSORY_REVIEW_REPUTATION` | **Submitter-reputation spend control (internal-only).** Extends the AI-spend gate: a new / burst / low-reputation submitter is downgraded to a deterministic-only review (the paid AI neurons are skipped); good-reputation submitters proceed normally. The per-(project, submitter) outcome is recorded after the gate decides. **Never surfaced publicly** — no comment, label, or check shows reputation. Per-PR — also gated by `GITTENSORY_REVIEW_REPOS`. | `false` | Flip to `true` + allowlist the repo. Thresholds are generic anti-abuse defaults (they reveal no review direction) and are not per-repo tunable. | `"true"` |
| `GITTENSORY_REVIEW_UNIFIED_COMMENT` | Renders the public PR comment as **one in-place unified comment** (the converged comment shape) instead of the legacy multi-panel comment. Per-PR — also gated by `GITTENSORY_REVIEW_REPOS`. | `false` | Flip to `true` + allowlist the repo. Flag-OFF keeps the legacy comment byte-identical. | `"true"` |
| `GITTENSORY_REVIEW_INLINE_COMMENTS` | **Quiet inline review comments** (CodeRabbit-style). On top of the decision summary, the AI reviewer leaves **non-blocking** inline comments on specific changed lines (`event: COMMENT`, never a change-request) — so a contributor sees exactly what to fix on a resubmission without the gate ever changing. Each comment's line is validated against the PR diff (out-of-diff findings are dropped, never a 422). Per-PR — also requires the repo in `GITTENSORY_REVIEW_REPOS` **and** `review.inline_comments: true` in its `.gittensory.yml`. | `false` | Flip to `true`, allowlist the repo, and set `review.inline_comments: true`. Flag-OFF the model is never asked for inline findings (byte-identical). | `"true"` |
| `GITTENSORY_REVIEW_OPS` | **Observability (read-only).** Drives two operator surfaces off your own review-outcome data: (1) on the cron tick, an anomaly scan over the gate-block ledger + recommendation/slop calibration emits a structured `ops_anomaly` log when something drifts (gate false-positive spike, slop score inverting, recommendation negative-rate spike); and (2) a bearer-gated `GET /v1/internal/ops/stats` outcome aggregate. **Read-only** — does not mutate config. Global (not scoped by `GITTENSORY_REVIEW_REPOS`). | `false` | Flip to `true` to enable the anomaly cron + the stats endpoint. Endpoint is bearer-gated (see secrets). | `"true"` |
| `GITTENSORY_REVIEW_SELFTUNE` | **Self-improvement / auto-tune loop.** On the cron tick, computes tuning recommendations from your own review-outcome data, **shadow-soaks** any strictly-tightening recommendation, and auto-promotes it to live **only** after the soak window passes the gate; every action is audited. It can **only ever tighten** the gate — a loosening recommendation is never applied. Global. *Note:* reading a promoted override back into the live gate is a deferred follow-up; today it records recommendations + shadow-soak + audit. | `false` | Flip to `true` to enable the self-tuning cron. Direction is enforced (tightening-only) — safe to leave on. | `"true"` |
| `GITTENSORY_REVIEW_PARITY_AUDIT` | **Parity readiness (shadow, record-only).** Shadow-records each finalized native gate decision into the audit-source table and serves a pre-cutover parity readiness report at `GET /v1/internal/parity`. Recording changes **no** review behavior. Global. | `false` | Flip to `true` during a validation window to collect parity data; turn off when done. | `"true"` |
| `GITTENSORY_REVIEW_CONTENT_LANE` | **Content-review lane.** Routes *content* repos (curated lists, registries) through the dedicated content lane — duplicate detection, source-evidence reachability, security scanning, scope classification, registry/netuid grounding — instead of the code gate. Global. Flag-OFF the lane is never reached. | `false` | Flip to `true` to route content repos through the lane at cutover. | `"true"` |
| `GITTENSORY_REVIEW_DRAFT` | **Public draft-submission flow.** Enables the `/v1/drafts` endpoints: a contributor draft → GitHub OAuth → fork PR opened against the content repo. Flag-OFF every draft endpoint 404s and nothing is written. Global. | `false` | Flip to `true` **and** set the `DRAFT_TOKEN_ENCRYPTION_SECRET` and `GITHUB_OAUTH_CLIENT_SECRET` secrets (the endpoints 503 without the encryption secret). Optionally set `DRAFT_PUBLIC_REPO` / `DRAFT_BASE_REF`. | `"true"` |
| `GITTENSORY_REVIEW_STATS_TOKEN` | **Bearer secret** for the on-demand stats dashboard/data endpoint (not an on/off switch — it is the token value). When set, the stats data route requires this bearer token. | unset | Set via `wrangler secret put GITTENSORY_REVIEW_STATS_TOKEN`; rotate by overwriting. | `wrangler secret put GITTENSORY_REVIEW_STATS_TOKEN` |

### Rollout pattern

A safe rollout for a per-PR feature is two flips: turn the capability flag `true`, then add the repo
to `GITTENSORY_REVIEW_REPOS`. Because both must be true, you can leave a capability globally enabled
while it stays dormant everywhere except the repos you have explicitly converged — and you can roll a
single repo back by removing it from the allowlist without disturbing the others.

---

## 2. Per-repo configuration (`.gittensory.yml` + database settings)

Per-repo behavior is the **effective settings**: the database row for the repo, overlaid with the
repo's `.gittensory.yml`. `.gittensory.yml` wins where it sets a value; unset fields fall through to
the database row, and an absent database row falls through to the safe defaults below.

Gittensory looks for the manifest file at (first match wins):
`.gittensory.yml` → `.github/gittensory.yml` → `.gittensory.json` → `.github/gittensory.json`.

### Gate modes

Most gate dimensions are tri-state **gate-rule modes**: `off` / `advisory` / `block`.

- `off` — the dimension is not evaluated.
- `advisory` — the finding is **surfaced** (in the comment/context) but never blocks.
- `block` — the finding can become a hard `Gittensory Orb Review Agent` blocker. Blocking is always
  **confirmed-contributor-gated** — the mode chooses *which* deterministic checks are active, never
  *who* can be blocked.

The master switch is `gateCheckMode` (`off` / `enabled`). The per-dimension modes refine an
already-enabled gate.

| Setting | `.gittensory.yml` (`gate:`) | DB field | Type / values | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| Gate master switch | `gate.enabled` (bool) | `gateCheckMode` | `off` / `enabled` | `off` | Turns the whole deterministic gate on. Other gate modes refine it. |
| Policy pack | `gate.pack` | `gatePack` | `gittensor` / `oss-anti-slop` | `gittensor` | `gittensor` = confirmed-contributor-gated, registry-aware. `oss-anti-slop` runs the deterministic rules against any author on any repo. |
| Linked-issue gate | `gate.linkedIssue` | `linkedIssueGateMode` | `off`/`advisory`/`block` | `advisory` | If the dashboard "Require linked issue" toggle (`requireLinkedIssue`) is on but this is `off`, it is auto-promoted to `block`. |
| Duplicate-PR gate | `gate.duplicates` | `duplicatePrGateMode` | `off`/`advisory`/`block` | `block` | Detects duplicate/superseding PRs. |
| Quality / merge-readiness score signal | `gate.readiness.mode` | `qualityGateMode` | `off`/`advisory`/`block` | `advisory` | Advisory/informational only. `block` is accepted for older configs but does not fail the review-agent check. |
| Quality min score | `gate.readiness.minScore` | `qualityGateMinScore` | number 0–100 (nullable) | `null` | Advisory warning threshold for the readiness signal; `null` disables the threshold. |
| Slop gate | `gate.slop.mode` | `slopGateMode` | `off`/`advisory`/`block` | `off` | Deterministic anti-slop signal. `advisory` surfaces the slop score + warnings; `block` also hard-blocks at/above the min score. Opt-in. |
| Slop min score | `gate.slop.minScore` | `slopGateMinScore` | number 0–100 (nullable) | `null` (engine uses `60`, the "high" band) | The slop-risk threshold at/above which `slop block` blocks. |
| Slop AI advisory | `gate.slop.aiAdvisory` | `slopAiAdvisory` | bool | `false` | When `true` **and** slop is not `off`, a free Workers-AI pass adds an **advisory-only** `ai_slop_advisory` finding. Never feeds the slop score or the gate. |
| Merge-readiness gate | `gate.mergeReadiness` | `mergeReadinessGateMode` | `off`/`advisory`/`block` | `off` | Composite merge-readiness gate. No min score. |
| Manifest-policy gate | `gate.manifestPolicy` | `manifestPolicyGateMode` | `off`/`advisory`/`block` | `off` | When `block`, the manifest's declared policy (blocked paths, required-linked-issue, test expectations) becomes an enforceable blocker. Independent of merge-readiness. |
| First-time-contributor grace | `gate.firstTimeContributorGrace` | `firstTimeContributorGrace` | bool | `false` | When `true`, softens a would-be block to advisory for a genuine newcomer (0 merged PRs, < 3 closed-unmerged PRs). Repeat offenders and authors with merge history are gated normally. |
| AI review | `gate.aiReview.mode` | `aiReviewMode` | `off`/`advisory`/`block` | `off` | `advisory` posts AI review notes only; `block` lets a dual-model high-confidence consensus defect become a blocker (confirmed-contributors only). |
| AI review BYOK | `gate.aiReview.byok` | `aiReviewByok` | bool | `false` | When `true` and a provider key is configured, the *advisory* write-up uses the maintainer's frontier model. The consensus blocker always uses the free Workers-AI pair, so BYOK never changes who can be blocked. |
| AI review all authors | `gate.aiReview.allAuthors` | `aiReviewAllAuthors` | bool | `false` | When `true`, an enabled AI review runs for every PR author instead of only the engine's default eligible authors. Use this for self-host repos where the selected model must produce the public review summary. |
| AI review provider | `gate.aiReview.provider` | `aiReviewProvider` | `anthropic` / `openai` / `null` | `null` | `null` = use the stored key's own provider. Must match the stored key's provider or BYOK is skipped (Workers-AI fallback). The key itself is only in the encrypted key store. |
| AI review model | `gate.aiReview.model` | `aiReviewModel` | string / `null` | `null` | Model override for the BYOK advisory write-up (e.g. `claude-3-5-sonnet-latest`). `null` = the key record's model, else a conservative per-provider default. |
| AI close confidence | `gate.aiReview.closeConfidence` | `aiReviewCloseConfidence` | number 0–1 (nullable) | `null` (engine uses `0.93`) | Minimum **calibrated** AI-reviewer confidence for a consensus defect / split to **block** under `aiReview.mode: block`. Below-threshold AI defects stay advisory (visible, never close). Each reviewer rates its own confidence; consensus carries the weaker reviewer's. Config-as-code only (no dashboard/DB column). |

### Guardrails and scope (focus manifest)

The `.gittensory.yml` top-level keys declare the repo's focus and guardrails. These feed the
deterministic findings (e.g. `manifest_blocked_path`, `manifest_missing_tests`) and — when
`gate.manifestPolicy: block` — can become enforceable blockers.

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `wantedPaths` | string list (globs) | `[]` | Work areas the maintainer wants — PRs touching these are preferred/encouraged. |
| `blockedPaths` | string list (globs) | `[]` | Paths off-limits to contributors. Touching one yields a `manifest_blocked_path` finding; enforceable when `gate.manifestPolicy: block`. |
| `preferredLabels` | string list | `[]` | Labels the maintainer prefers on incoming PRs; a missing preferred label is surfaced. |
| `linkedIssuePolicy` | `required` / `preferred` / `optional` | `optional` | How strongly a linked issue is expected. |
| `testExpectations` | string list | `[]` | Test paths/areas expected to change with code; a `manifest_missing_tests` finding fires when absent. |
| `issueDiscoveryPolicy` | `encouraged` / `neutral` / `discouraged` | `neutral` | Whether opening discovery issues is encouraged. |
| `maintainerNotes` | string list | `[]` | **Private** review context — never published to a public GitHub surface. |
| `publicNotes` | string list | `[]` | Notes explicitly opted into public output (public-safe filtered; unsafe lines are dropped). |

### Generic `settings:` overrides and other repo settings

Everything a maintainer can toggle in the dashboard can be set as code under `settings:` in
`.gittensory.yml`. Common ones (all default to the safe values shown):

| Setting | DB field | Values | Default |
| --- | --- | --- | --- |
| Comment audience | `commentMode` | `off` / `detected_contributors_only` / `all_prs` | `detected_contributors_only` |
| Public audience mode | `publicAudienceMode` | `oss_maintainer` / `gittensor_only` | `oss_maintainer` |
| Public signal level | `publicSignalLevel` | `minimal` / `standard` | `standard` |
| Check-run publishing | `checkRunMode` | `off` / `enabled` | `off` |
| Check-run detail | `checkRunDetailLevel` | `minimal` / `standard` / `deep` | `minimal` |
| Public surface | `publicSurface` | `off` / `comment_and_label` / `comment_only` / `label_only` | `comment_and_label` |
| Auto-label | `autoLabelEnabled` | bool | `true` |
| Label name | `gittensorLabel` | string | `gittensor` |
| Create missing label | `createMissingLabel` | bool | `true` |
| Include maintainer authors | `includeMaintainerAuthors` | bool | `false` |
| Require linked issue | `requireLinkedIssue` | bool | `false` |
| Backfill | `backfillEnabled` | bool | `true` |
| Private trust | `privateTrustEnabled` | bool | `true` |
| README status badge | `badgeEnabled` | bool | `false` |
| Agent paused (per-repo kill-switch) | `agentPaused` | bool | `false` |
| Agent dry-run / shadow | `agentDryRun` | bool | `false` |
| Autonomy dial | `autonomy` | per-action-class level (`observe`…`auto`) | `{}` (= `observe`, deny-by-default) |
| Auto-maintain policy | `autoMaintain` | `{ mergeMethod, requireApprovals }` | `squash` / `1` |
| Command authorization | `commandAuthorization` | role policy | built-in default policy |
| Contributor blacklist | `contributorBlacklist` | list of `{ login, reason?, evidence?, addedAt? }` (login required) | `[]` |
| Blacklist label | `blacklistLabel` | string | `slop` |

The **contributor blacklist** is layered like every other setting (`.gittensory.yml`
`settings.contributorBlacklist` > database) and is unioned with the shared/global list. Logins are
public data, but the optional `reason`, `evidence`, and `addedAt` fields are maintainer metadata
for configuration/audit context and are not echoed in automated public close comments. `blacklistLabel`
(default `slop`) is the label the engine applies to a blacklisted author's PR.

A PR from a **blacklisted login** is labeled (`blacklistLabel`) and **closed deterministically** —
ahead of any merit/CI/AI analysis, with a static public close comment and **no AI call**. The close
short-circuits and **wins over the normal gate disposition**; it honors the autonomy dial and
`agentPaused` / `agentDryRun` exactly like any other agent action, and the owner and automation bots
are never auto-closed.

### Example `.gittensory.yml`

```yaml
# Focus / guardrails
wantedPaths:
  - "src/**"
blockedPaths:
  - "vendor/**"
  - ".github/workflows/**"
testExpectations:
  - "tests/**"
linkedIssuePolicy: preferred

# Gate policy (refines an enabled gate)
gate:
  enabled: true
  pack: gittensor
  duplicates: block
  linkedIssue: advisory
  readiness:
    mode: advisory
    minScore: 70
  slop:
    mode: block
    minScore: 60
    aiAdvisory: true
  mergeReadiness: advisory
  manifestPolicy: block
  firstTimeContributorGrace: true
  aiReview:
    mode: advisory
    byok: true
    allAuthors: true
    provider: anthropic
    model: claude-3-5-sonnet-latest

# Generic dashboard-equivalent overrides
settings:
  commentMode: detected_contributors_only
  checkRunMode: enabled
  checkRunDetailLevel: standard
  badgeEnabled: true
  blacklistLabel: slop
  contributorBlacklist:
    - login: known-plagiarist
      reason: plagiarism
      evidence:
        - https://github.com/owner/repo/pull/1
      addedAt: "2026-06-26"
    - bad-farmer            # bare login shorthand is also accepted

# Review write-up + inline-review overrides (manifest-only; no dashboard equivalent)
review:
  profile: balanced          # chill | balanced | assertive — how nitpicky the AI write-up is
  inline_comments: true      # leave quiet, non-blocking inline comments on changed lines
                             #   (also needs GITTENSORY_REVIEW_INLINE_COMMENTS=true + the repo allowlisted)
```

---

## 3. Required secrets (by name)

Set these as worker secrets (`wrangler secret put NAME`) — they are **not** committed to
`wrangler.jsonc`. Required secrets must be present for the worker to run; optional secrets gate a
specific capability and degrade safely when absent.

**Core (required):**

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_SLUG`
- `GITTENSOR_REGISTRY_URL`
- `GITTENSORY_API_TOKEN`
- `GITTENSORY_MCP_TOKEN`
- `INTERNAL_JOB_TOKEN`

**Optional (capability-gated):**

- `GITHUB_OAUTH_CLIENT_ID` — GitHub OAuth (dashboard sign-in, draft flow).
- `GITHUB_OAUTH_CLIENT_SECRET` — GitHub OAuth; also required by the draft flow.
- `GITHUB_PUBLIC_TOKEN` — unauthenticated public-GitHub reads (e.g. fetching a repo's `.gittensory.yml`).
- `TOKEN_ENCRYPTION_SECRET` — AES-256-GCM master secret for maintainer BYOK provider keys at rest. Absent ⇒ BYOK unavailable; AI review uses the self-host instance reviewer when configured.
- `DRAFT_TOKEN_ENCRYPTION_SECRET` — AES-256-GCM secret for the contributor OAuth token in the draft flow. Absent ⇒ draft create/callback endpoints return 503.
- `GITTENSORY_REVIEW_STATS_TOKEN` — bearer token guarding the stats data endpoint.
- `GITTENSORY_DRIFT_ISSUE_TOKEN` — token for auto-filing drift issues.
- `GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN` — token for contributor-issue automation.
- `PRODUCT_USAGE_HASH_SALT` — salt for hashing product-usage identifiers.

**Related self-host infrastructure** (not secrets, but gate capabilities when configured): `QDRANT_URL`
or the built-in sqlite vector store for RAG, `REVIEW_AUDIT_DIR` for screenshot blob persistence, and
`BROWSER_WS_ENDPOINT` for visual capture. The Cloudflare API worker no longer binds Workers AI,
Vectorize, R2 review audit storage, or Browser Rendering for review execution.
