declare global {
  interface Env {
    DB: D1Database;
    JOBS: Queue;
    RATE_LIMITER?: DurableObjectNamespace;
    AI?: Ai;
    /** Convergence (infra): Vectorize index for codebase RAG retrieval (Layer C). Optional — the review is
     *  fully fail-safe without it (absent ⇒ no RAG, review proceeds with no retrieved context). The index is
     *  created with bge-m3's 1024 dimensions. Unused until the per-module RAG wiring chunk; an unbound deploy
     *  is inert (`createReviewAdapters` degrades a missing binding to an unavailable vector adapter). */
    VECTORIZE?: Vectorize;
    /** Convergence (infra): R2 bucket for review audit + visual-capture blobs. Optional — absent ⇒ no
     *  audit/screenshot persistence. Unused until the per-module wiring chunk; an unbound deploy is inert. */
    REVIEW_AUDIT?: R2Bucket;
    /** Convergence (infra): Browser Rendering binding for visual (before/after screenshot) capture. Optional —
     *  absent ⇒ no visual capture. Unused until the per-module wiring chunk; an unbound deploy is inert. */
    BROWSER?: Fetcher;
    /** Convergence (infra): the shared REVIEW_CONFIG KV (reviewbot's per-repo config, keyed by repo slug).
     *  The converged auto-maintain path resolves each repo's `hardGuardrailGlobs` from it so guarded paths
     *  force MANUAL review (no auto-merge / auto-close). Optional — absent ⇒ the conservative
     *  DEFAULT_CRUCIAL_GUARDRAIL_GLOBS fallback applies (CI workflows + scripts still guarded). */
    REVIEW_CONFIG?: KVNamespace;
    /** TODO (convergence follow-up): a per-PR LOCK Durable Object (`SubmissionLock` mutex) is a separate,
     *  more-involved sub-task — it needs the ported DO class + its own migration tag, not just a binding here.
     *  Deliberately NOT declared in this chunk; the review path keeps its current concurrency behavior. */
    PUBLIC_API_ORIGIN?: string;
    PUBLIC_SITE_ORIGIN?: string;
    AI_SUMMARIES_ENABLED?: string;
    AI_PUBLIC_COMMENTS_ENABLED?: string;
    WORKERS_AI_SUMMARY_MODEL?: string;
    AI_DAILY_NEURON_BUDGET?: string;
    /** Per-repository/day cap for maintainer-paid BYOK AI review provider calls. */
    AI_BYOK_DAILY_REPO_LIMIT?: string;
    AI_MAX_OUTPUT_TOKENS?: string;
    /** Optional Cloudflare AI Gateway id. When set, free Workers-AI review calls route through the gateway
     *  for caching, rate-limiting, request logging, and fallback. Unset = direct binding calls (unchanged). */
    AI_GATEWAY_ID?: string;
    /** Self-host AI provider selection + dual-review config (#dual-ai-combiner). `AI_PROVIDER` is a comma list of
     *  providers (claude-code, codex, anthropic, ollama, …); `AI_COMBINE` picks single|consensus|synthesis (default
     *  synthesis for two); `AI_ON_MERGE` is the synthesis rule either|both. `AI_EFFORT` is the Claude Code
     *  intelligence dial (low|medium|high|xhigh|max, default high). `AI_REVIEW_PLAN` is the resolved plan
     *  (computed from these at boot in server.ts and read at the review call site); undefined on cloud. */
    AI_PROVIDER?: string;
    AI_COMBINE?: string;
    AI_ON_MERGE?: string;
    AI_EFFORT?: string;
    AI_REVIEW_PLAN?: { reviewers: Array<{ model: string }>; combine: import("./services/ai-review").CombineStrategy; onMerge?: import("./services/ai-review").OnMerge | undefined };
    ADMIN_GITHUB_LOGINS?: string;
    GITHUB_WEBHOOK_SECRET: string;
    GITHUB_WEBHOOK_MAX_BODY_BYTES?: string;
    /** Webhook secret for the central Gittensory Orb GitHub App (#1255) — distinct from the review app's
     *  GITHUB_WEBHOOK_SECRET. Verifies inbound POST /v1/orb/webhook deliveries. Inject as a wrangler secret. */
    ORB_GITHUB_WEBHOOK_SECRET?: string;
    /** The central Orb GitHub App's OWN credentials (separate from the gittensory review App above). Inject as
     *  wrangler secrets. Used to mint the Orb App JWT → list installations + mint short-lived installation tokens
     *  (the token-broker). CLIENT_ID/SECRET drive the OAuth onboarding flow. */
    ORB_GITHUB_APP_ID?: string;
    ORB_GITHUB_APP_PRIVATE_KEY?: string;
    ORB_GITHUB_CLIENT_ID?: string;
    ORB_GITHUB_CLIENT_SECRET?: string;
    /** Master flag for the Orb token-broker (enrollment OAuth + /v1/orb/token). Default-off: every broker route
     *  early-404s until this is "true", so the deploy is byte-identical until an operator enables it. */
    ORB_BROKER_ENABLED?: string;
    /** SELF-HOST broker CLIENT: the one-time enrollment secret the operator issued for this install. When set, the
     *  engine sources GitHub installation tokens from the central Orb (POST /v1/orb/token) instead of a local App
     *  key. Cloud never sets it ⇒ inert there. See src/orb/broker-client. (A secret — never commit a real value.) */
    ORB_ENROLLMENT_SECRET?: string;
    /** Override the Orb broker base URL the self-host client calls (default https://gittensory-api.aethereal.dev);
     *  point at a private gittensory deployment if you self-host the broker too. */
    ORB_BROKER_URL?: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_SLUG: string;
    GITHUB_OAUTH_CLIENT_ID?: string;
    GITHUB_OAUTH_CLIENT_SECRET?: string;
    GITTENSOR_UPSTREAM_REPO?: string;
    GITTENSOR_UPSTREAM_REF?: string;
    GITTENSOR_REGISTRY_URL: string;
    GITHUB_PUBLIC_TOKEN?: string;
    /** #703: owner-gated global to apply upstream sigmoid time-decay in score previews. Default off. */
    SCORING_TIME_DECAY_ENABLED?: string;
    /** #776 agent-layer GLOBAL kill-switch — when truthy, halts ALL agent actions across every repo. */
    AGENT_ACTIONS_PAUSED?: string;
    /** Self-host instance-wide write switch: "dry-run" | "disabled" forces EVERY installation write to be
     *  suppressed regardless of per-repo mode (the cloud→self-host parallel-run kill switch). Unset = live. */
    SELFHOST_DEPLOYMENT_MODE?: string;
    /** Self-host container-private per-repo config dir. When set, the focus-manifest loader reads
     *  `{dir}/{owner}__{repo}.{yml,yaml,json}` INSTEAD of the public `.gittensory.yml`, so review policy (gate,
     *  autonomy, labels, model/effort) is set privately and contributors can't read or game it. Unset ⇒ public
     *  fetch (cloud, or a self-host without the dir, is byte-identical to before). */
    GITTENSORY_REPO_CONFIG_DIR?: string;
    GITTENSORY_AUTO_FILE_DRIFT_ISSUES?: string;
    GITTENSORY_DRIFT_ISSUE_REPO?: string;
    GITTENSORY_DRIFT_ISSUE_TOKEN?: string;
    /** Comma-separated GitHub logins assigned to filed upstream-drift issues (default: the gittensory
     *  maintainer). Lets a self-host operator route drift issues to their own team. */
    GITTENSORY_DRIFT_ISSUE_ASSIGNEES?: string;
    /** Self-host default Discord webhook URL — per-action notifications (merged/closed/manual) for any repo
     *  not in the built-in per-repo map. Lets a self-host operator wire one channel without a source edit. */
    DISCORD_WEBHOOK_URL?: string;
    /** Self-host Slack incoming-webhook URL (`https://hooks.slack.com/services/…`) — per-action notifications
     *  (merged/closed/manual) for ANY repo. Sibling of DISCORD_WEBHOOK_URL; set either, both, or neither. */
    SLACK_WEBHOOK_URL?: string;
    GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN?: string;
    PRODUCT_USAGE_HASH_SALT?: string;
    GITTENSORY_API_TOKEN: string;
    GITTENSORY_MCP_TOKEN: string;
    INTERNAL_JOB_TOKEN: string;
    /** Shared bearer secret required by the hosted Orb ingest collector. */
    ORB_INGEST_TOKEN?: string;
    /** AES-256-GCM master secret for maintainer BYOK provider keys (encrypt/decrypt at rest). A Worker
     *  secret (`wrangler secret put`), never a public var. When absent, BYOK is unavailable and the AI
     *  review silently falls back to free Workers AI. */
    TOKEN_ENCRYPTION_SECRET?: string;
    RATE_LIMIT_TRUSTED_PROXIES?: string;
    RATE_LIMIT_TRUSTED_PROXY_COUNT?: string;
    /** Convergence (Stage D): when truthy, the public PR comment is rendered by the unified-comment bridge
     *  (ONE in-place comment in the converged shape) instead of the legacy `buildPublicPrIntelligenceComment`
     *  panel. Default OFF — unset/false keeps the legacy panel byte-identical. */
    GITTENSORY_REVIEW_UNIFIED_COMMENT?: string;
    /** Inline comments (#inline-comments): when truthy (AND the repo is in GITTENSORY_REVIEW_REPOS AND the repo's
     *  `.gittensory.yml` sets `review.inline_comments: true`), the AI reviewer ALSO leaves quiet, NON-BLOCKING
     *  inline comments on specific changed lines, layered on top of the decision summary. Default OFF —
     *  unset/false keeps the review path byte-identical (the model is never asked for inline findings). */
    GITTENSORY_REVIEW_INLINE_COMMENTS?: string;
    /** Convergence (safety): when truthy, the ported safety scan runs in the review path — (1) untrusted PR
     *  title/body/diff is defanged (prompt-injection neutralized) before it reaches the AI reviewer, and (2)
     *  the PR diff is scanned for leaked secrets, surfacing a `secret_leak` blocker. Default OFF —
     *  unset/false keeps the review path byte-identical (no new branch is taken). */
    GITTENSORY_REVIEW_SAFETY?: string;
    /** Convergence (visual capture): when truthy, the review path captures a before/after screenshot for
     *  PRs that touch WEB-VISIBLE files (frontend pages / public OG images — see review/visual/paths.ts
     *  isVisualPath). "before" = production (PUBLIC_SITE_ORIGIN); "after" = the PR's preview deploy. Each shot
     *  is rendered via the BROWSER (Browser Rendering) binding, stored in the REVIEW_AUDIT R2 bucket, and
     *  embedded in the unified PR comment as a "Visual preview" table served from the PUBLIC /gittensory/shot
     *  route. Needs the BROWSER + REVIEW_AUDIT bindings; degrades gracefully (placeholders / dashes) without
     *  them. Backend .ts/.md/.json/.py PRs NEVER trigger capture. Capture runs for a repo ONLY IF this flag is
     *  ON *AND* the repo is in GITTENSORY_REVIEW_REPOS (the per-repo cutover allowlist) — see
     *  review/visual-wire.ts screenshotsAllowed. Default OFF — unset/false captures nothing (no render, no R2
     *  write, no comment change) so the review path is byte-identical to today. */
    GITTENSORY_REVIEW_SCREENSHOTS?: string;
    /** Convergence (grounding): when truthy, the AI reviewer prompt is GROUNDED — the PR's finished CI status
     *  + the FULL post-change content of the changed files are appended so a non-frontier model verifies its
     *  claims against reality instead of predicting CI / flagging symbols defined just outside the hunk.
     *  Default OFF — unset/false keeps the reviewer prompt byte-identical and makes no extra GitHub fetch. */
    GITTENSORY_REVIEW_GROUNDING?: string;
    /** Convergence (reputation): when truthy, the INTERNAL-only ported submitter-reputation signal extends the
     *  AI-spend gate — a new / burst / low-reputation submitter is downgraded to a deterministic-only review
     *  (the AI neurons are skipped), and the per-(project, submitter) outcome is recorded after the gate
     *  decides. STRICTLY INTERNAL: the reputation never appears in any public comment/check. Default OFF —
     *  unset/false reads NO reputation, records NOTHING, and leaves the AI-spend gate byte-identical (the new
     *  branch is unreachable when off). */
    GITTENSORY_REVIEW_REPUTATION?: string;
    /** Convergence (ops / observability): when truthy, gittensory's OWN review-outcome data drives two
     *  operator surfaces — (1) on the cron tick, an anomaly scan over the gate-block ledger + recommendation /
     *  slop calibration emits a structured `ops_anomaly` log when something drifts (gate false-positive spike,
     *  slop score inverting, a recommendation negative-rate spike); and (2) a bearer-gated
     *  `GET /v1/internal/ops/stats` endpoint serves the cross-repo outcome aggregate. Default OFF — unset/false
     *  means the cron tick enqueues NO ops job (does no new work) and the endpoint 404s, so the worker is
     *  byte-identical to today. NOTE: this is read-only OBSERVABILITY only; the auto-tune / config-mutation
     *  self-improve loop (src/review/auto-apply.ts) is deliberately NOT wired here — see ops-wire.ts. */
    GITTENSORY_REVIEW_OPS?: string;
    /** Convergence (RAG retrieval): when truthy, the AI reviewer prompt gains a RELEVANT EXISTING CODE / DOCS
     *  section — at review time the codebase vector index is queried for code/docs semantically related to the
     *  PR's changed files (callers, related modules, existing conventions) and appended as additive reference
     *  context, exactly like grounding (see review/rag-wire). Default OFF — unset/false performs NO retrieval,
     *  uses NO adapter, makes NO vector query, and keeps the reviewer prompt byte-identical (the new branch is
     *  unreachable when off). Even when ON, retrieval is INERT until a vector index exists for the repo (a
     *  cold/missing index degrades to no context) — the index-population job is a deploy-time follow-up. */
    GITTENSORY_REVIEW_RAG?: string;
    /** Convergence flag: the deterministic content/registry SURFACE LANE drives the gate for registry-submission
     *  PRs (metagraphed surfaces[]/providers/candidates). Truthy ON *AND* the repo in GITTENSORY_REVIEW_REPOS —
     *  see review/content-lane-wire. Default OFF: unset/false takes no new branch, runs no fetch, and leaves the
     *  gate disposition byte-identical. AI-FREE (pure structured-data adjudication), so independent of the AI
     *  reviewer; a generic hard blocker (e.g. a committed secret) is always preserved over a surface "merge". */
    GITTENSORY_REVIEW_CONTENT_LANE?: string;
    /** Convergence (self-improve / auto-tune): when truthy, the ported self-improvement loop
     *  (src/review/auto-tune.ts + auto-apply.ts) runs on the cron tick over gittensory's OWN review-outcome
     *  data — it computes tuning recommendations, SHADOW-SOAKS any STRICTLY-TIGHTENING recommendation in the
     *  `tunables_overrides_shadow` table, and AUTO-PROMOTES it to `tunables_overrides` ONLY after the soak
     *  window passes the gate (tightening + evidence + soaked). Every action is recorded to `override_audit`.
     *  It can ONLY EVER tighten the gate — a loosening recommendation carries no payload and is never applied
     *  (isStrictlyTightening + evaluateShadowPromotion enforce the direction). Default OFF — unset/false means
     *  the cron enqueues NO selftune job (does ZERO tuning work, reads/writes NO override), so the worker is
     *  byte-identical to today. NOTE: config-application is DEFERRED — a promoted override is NOT yet read by
     *  the live gate-config resolution (gittensory has no confidenceFloor/scopeCap tunable and its native
     *  signal measures gate false positives, a loosening direction); the shadow-soak + audit + recommendation
     *  recording are wired, reading a promoted override into the live gate is a noted follow-up that must not
     *  risk loosening the gate. See src/review/selftune-wire.ts. */
    GITTENSORY_REVIEW_SELFTUNE?: string;
    /** Convergence (#issue-coding-plan): the `@gittensory plan` command. Default OFF — `@gittensory plan` falls
     *  through to the existing mention path, so the worker is byte-identical to today. When truthy, a MAINTAINER
     *  comment of `@gittensory plan` on an issue generates an implementation plan from the issue text via Workers
     *  AI and posts it as an issue comment. See src/review/planner.ts. */
    GITTENSORY_REVIEW_PLANNER?: string;
    /** Proof of Power (#1059): when truthy, the unauthenticated `GET /v1/public/stats` endpoint serves the public
     *  homepage counter — computed LIVE from gittensory's OWN review ledger (review_targets + review_audit) behind
     *  a 60s cache, so it stays current as new reviews land. Default OFF — unset/false 404s the endpoint, so the
     *  worker is byte-identical to today. Exposes review-disposition counts + a reversal-grounded accuracy
     *  percentage + an estimated-time-saved figure ONLY — never PR content, authors, scores, or reward internals.
     *  See review/public-stats.ts. */
    GITTENSORY_PUBLIC_STATS?: string;
    /** Convergence (port): public OAuth draft-submission flow ported from reviewbot. When truthy, the
     *  /v1/drafts endpoints accept a contributor draft -> GitHub OAuth -> fork PR against the content repo.
     *  Default OFF — unset/false makes every draft endpoint 404 and writes nothing (byte-identical worker). */
    GITTENSORY_REVIEW_DRAFT?: string;
    /** owner/repo the draft fork PR targets (defaults to the awesome-claude content repo when unset). */
    DRAFT_PUBLIC_REPO?: string;
    /** Base branch the draft PR opens against (defaults to "main"). */
    DRAFT_BASE_REF?: string;
    /** AES-256-GCM secret used to encrypt the short-lived contributor OAuth token at rest. A Worker
     *  secret (`wrangler secret put`). When absent, the draft create/callback endpoints return 503. */
    DRAFT_TOKEN_ENCRYPTION_SECRET?: string;
    /** Convergence prep (#preconv-parity): when truthy, the gittensory-native review path SHADOW-records each
     *  finalized gate decision (source='gittensory-native') into the `review_audit` audit-source table (D1
     *  migration 0049), and the bearer-gated `GET /v1/internal/parity` endpoint serves the pre-cutover parity
     *  READINESS report (computeGateParity / isParityCutoverReady over the recorded data). RECORD-ONLY SHADOW
     *  mode — recording changes NO review behavior. Default OFF — unset/false records NOTHING (no D1 write, the
     *  review path is byte-identical) and the endpoint 404s. NOTE: this records the gittensory-native side only;
     *  the actual COMPARISON vs reviewbot's authoritative decisions needs reviewbot's rows in the SAME table,
     *  written by the deploy-time dual-run shadow step (out of scope here). See src/review/parity-wire.ts. */
    GITTENSORY_REVIEW_PARITY_AUDIT?: string;
    /** Convergence (cutover): comma-separated allowlist of repo full-names ("owner/repo") that may run the
     *  PER-PR converged review features (safety defang + secret-leak, grounding, RAG, reputation AI-skip/record,
     *  unified comment). A feature activates for a repo ONLY IF its existing global flag is ON AND the repo is
     *  in this allowlist — letting the cutover roll forward (or back) one repo at a time. Matching is
     *  case-insensitive on the trimmed "owner/repo". Default "" (unset/empty/whitespace) → NO repos → every
     *  per-PR converged feature stays OFF for ALL repos regardless of the global flags (byte-identical dormant
     *  deploy). The cron/endpoint flags (ops / selftune / parity / content-lane / draft) are NOT scoped by
     *  this allowlist — they stay global. See src/review/cutover-gate.ts. */
    GITTENSORY_REVIEW_REPOS?: string;
    /** Duplicate-winner adjudication (#dup-winner): when truthy, a same-issue duplicate cluster of OPEN PRs
     *  spares exactly ONE winner — the EARLIEST opened = the LOWEST PR number among the OPEN siblings — instead
     *  of gate-blocking + auto-closing every sibling. Only the LOSERS get the `duplicate_pr_risk` blocker, the
     *  "duplicate of another open PR" close reason, the slop duplicate-cluster penalty, and the panel hard
     *  duplicate block; the winner is judged on its OWN merits (CI / conflict / gate / linked-issue / slop).
     *  Default OFF — unset/false ⇒ every duplicate sibling dies (today's behavior, byte-identical: the new
     *  guards short-circuit so the advisory finding, gate conclusion, close reason, slop, and panels are
     *  unchanged). Once a winner closes, the next-lowest OPEN sibling becomes the winner on re-eval. See
     *  src/signals/duplicate-winner.ts. */
    GITTENSORY_DUPLICATE_WINNER?: string;
  }
}

export {};
