declare global {
  interface Env {
    DB: D1Database;
    JOBS: Queue;
    /** Self-host webhook queue binding. Cloudflare no longer binds this because hosted reviews are retired. */
    WEBHOOKS?: Queue;
    RATE_LIMITER?: DurableObjectNamespace;
    AI?: Ai;
    /** Self-host (RAG): a DEDICATED embedding provider, kept SEPARATE from the review chat chain so the reviewer
     *  stays frontier-only (claude-code/codex) while embeddings — which those CLIs cannot produce — route to a
     *  local/openai-compatible endpoint (ollama). Built at boot from AI_EMBED_BASE_URL/AI_EMBED_MODEL. Absent ⇒
     *  `createReviewAdapters` falls back to `env.AI` (byte-identical to before). */
    AI_EMBED?: Ai;
    /** Self-host (visual-vision, #4111/#4335): a DEDICATED vision-capable provider, separate from both the
     *  review chain and the embed provider — a local/openai-compatible endpoint (ollama + a vision-language
     *  model). Built at boot from AI_VISION_BASE_URL/AI_VISION_MODEL. Absent ⇒ visual-vision advisory falls
     *  back to requiring a maintainer BYOK key (the only option before this binding existed). */
    AI_VISION?: Ai;
    /** Self-host (advisory-tier, #4364): a DEDICATED local-inference provider shared by every capability that is
     *  NEVER gate-blocking (slop advisory, e2e test-gen, issue planner, AI summaries) — separate from the review
     *  chain, the embed provider, and the vision provider, since none of these need frontier-model accuracy.
     *  Built at boot from AI_ADVISORY_BASE_URL/AI_ADVISORY_MODEL. Which capability actually routes through it is
     *  config-driven (`.gittensory.yml`, global default + per-repo override), not hardcoded here. Absent ⇒ every
     *  advisory capability falls back to `env.AI` (byte-identical to before this binding existed). */
    AI_ADVISORY?: Ai;
    /** Self-host RAG vector adapter. Cloudflare no longer binds Vectorize for hosted reviews; the Node runtime
     *  injects Qdrant/sqlite/pg adapters here when configured. Absent ⇒ no RAG, review proceeds with no retrieved
     *  context. */
    VECTORIZE?: Vectorize;
    /** Self-host RAG vector width. Must match the configured embedding model and vector backend. */
    QDRANT_DIM?: string;
    /** Self-host RAG embed batch size (items per embed-provider call). Defaults to the shipped
     *  Workers-AI-safe constant (96) when unset — this override exists for self-host operators tuning
     *  throughput on their own hardware (e.g. GPU-accelerated Ollama), not to change the hosted default. */
    AI_EMBED_BATCH?: string;
    /** Optional self-host review audit + visual-capture blob store. The Node runtime injects a filesystem-backed
     *  store when REVIEW_AUDIT_DIR is set, or an S3-compatible-bucket-backed store (an operator's own Cloudflare
     *  R2 bucket, or any other S3-compatible provider) when REVIEW_AUDIT_S3_BUCKET + _ENDPOINT +
     *  _ACCESS_KEY_ID + _SECRET_ACCESS_KEY are all set (takes priority when both are configured); the
     *  Cloudflare API worker no longer binds the review R2 bucket. */
    REVIEW_AUDIT?: R2Bucket;
    /** Public base URL for an S3-compatible REVIEW_AUDIT bucket's own public read access (an R2 `r2.dev` public
     *  bucket URL, or a custom domain connected to the bucket) -- see src/selfhost/s3-blob-store.ts. When set,
     *  capture.ts's resolveShotUrl links screenshots DIRECTLY at `${this}/${key}` so GitHub's image proxy (and
     *  every other viewer) fetches straight from the bucket's own CDN, never touching this instance's
     *  PUBLIC_API_ORIGIN at all. Unset (default) ⇒ served through this instance's own /gittensory/shot?key=
     *  proxy route instead, exactly as before -- the bucket still gets used for storage, just not linked to
     *  directly. Only meaningful alongside a configured REVIEW_AUDIT_S3_* bucket; ignored otherwise. */
    REVIEW_AUDIT_S3_PUBLIC_URL?: string;
    /** Optional visual capture binding. Self-host exposes this when BROWSER_WS_ENDPOINT is set; the Cloudflare API
     *  worker no longer binds Browser Rendering for reviews. */
    BROWSER?: Fetcher;
    /** Self-host transient cache for short-lived coalescing/backpressure keys. */
    SELFHOST_TRANSIENT_CACHE?: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ttlSeconds: number): Promise<void>;
      del?(key: string): Promise<void>;
      /** Atomic "set only if absent": returns true when this call newly claimed the key, false when it was
       *  already held by someone else. Unlike a get-then-set pair, there is no window where two concurrent
       *  callers can both observe an absent key and both claim it — the store (e.g. Redis SET NX) performs the
       *  check-and-set as one operation. Must be paired with `releaseIfValue` — self-host boot rejects
       *  `claim()` without it; runtime callers fail open without exclusivity rather than pin locks (#2129). */
      claim?(key: string, value: string, ttlSeconds: number): Promise<boolean>;
      /** Atomic compare-and-delete: deletes `key` only when its current value equals `value`, returning whether
       *  it was removed. Lets a lock holder release its OWN claim without risking a stale post-TTL release
       *  deleting a different holder's live claim on the same key. Required on any adapter that implements
       *  `claim()` (validated at self-host boot). */
      releaseIfValue?(key: string, value: string): Promise<boolean>;
    };
    /** TODO (convergence follow-up): a per-PR LOCK Durable Object (`SubmissionLock` mutex) is a separate,
     *  more-involved sub-task — it needs the ported DO class + its own migration tag, not just a binding here.
     *  Deliberately NOT declared in this chunk; the review path keeps its current concurrency behavior. */
    PUBLIC_API_ORIGIN?: string;
    PUBLIC_SITE_ORIGIN?: string;
    AI_SUMMARIES_ENABLED?: string;
    AI_PUBLIC_COMMENTS_ENABLED?: string;
    /** Model id for a genuine Cloudflare Workers AI binding only — no live deployment (hosted or self-host)
     *  binds `env.AI` to Workers AI today (see CONVERGENCE_RUNBOOK.md), and self-host discards any
     *  `@cf/`-prefixed value here. Self-host operators should use the provider-specific `*_AI_MODEL` vars below. */
    WORKERS_AI_SUMMARY_MODEL?: string;
    /** Daily spend cap in Cloudflare Workers AI "neurons" for the free/default-reviewer path (shared across
     *  ai-review/ai-slop/ai-summaries/planner). The unit name is a Workers-AI holdover; it's applied as a
     *  provider-agnostic heuristic budget regardless of which configured provider actually serves the request. */
    AI_DAILY_NEURON_BUDGET?: string;
    /** Per-repository/day cap for maintainer-paid BYOK AI review provider calls. */
    AI_BYOK_DAILY_REPO_LIMIT?: string;
    AI_MAX_OUTPUT_TOKENS?: string;
    /** Optional Cloudflare AI Gateway id for legacy env.AI-compatible adapters. Self-host review execution should
     *  prefer provider-specific AI_* configuration instead. */
    AI_GATEWAY_ID?: string;
    /** Self-host AI provider selection + reviewer config (#dual-ai-combiner). `AI_PROVIDER` is a comma list of
     *  providers (claude-code, codex, anthropic, ollama, ...). By default, the first provider is the reviewer and
     *  the first distinct later provider is its fallback; `AI_DUAL_REVIEW=1` makes the first two providers run as
     *  independent reviewers. In dual mode, `AI_COMBINE` picks single|consensus|synthesis and `AI_ON_MERGE` is the
     *  synthesis rule either|both. Provider-specific model/effort/timeout vars keep Claude/Codex/OpenAI/Ollama/
     *  Anthropic config explicit. `AI_REVIEW_PLAN` is the resolved plan (computed from these at boot in server.ts
     *  and read at the review call site); undefined on cloud. */
    AI_PROVIDER?: string;
    AI_DUAL_REVIEW?: string;
    AI_COMBINE?: string;
    AI_ON_MERGE?: string;
    CLAUDE_AI_MODEL?: string;
    CLAUDE_AI_EFFORT?: string;
    CLAUDE_AI_TIMEOUT_MS?: string;
    CODEX_AI_MODEL?: string;
    CODEX_AI_EFFORT?: string;
    CODEX_AI_TIMEOUT_MS?: string;
    OLLAMA_AI_BASE_URL?: string;
    OLLAMA_AI_API_KEY?: string;
    OLLAMA_AI_MODEL?: string;
    OPENAI_COMPATIBLE_AI_BASE_URL?: string;
    OPENAI_COMPATIBLE_AI_API_KEY?: string;
    OPENAI_COMPATIBLE_AI_MODEL?: string;
    OPENAI_AI_BASE_URL?: string;
    OPENAI_AI_MODEL?: string;
    ANTHROPIC_AI_BASE_URL?: string;
    ANTHROPIC_AI_MODEL?: string;
    AI_REVIEW_PLAN?: {
      reviewers: Array<{ model: string; fallback?: string | null | undefined }>;
      combine: import("./services/ai-review").CombineStrategy;
      onMerge?: import("./services/ai-review").OnMerge | undefined;
    };
    ADMIN_GITHUB_LOGINS?: string;
    /** Install-wide contributor open-item cap (#2562, anti-abuse): the max PRs+issues a single non-owner/
     *  admin/bot contributor may have open ACROSS EVERY repo this install gates, combined. Purely an
     *  install-scoped aggregate over this same database (no cross-instance networking) -- catches an actor
     *  spreading low-volume spam/farming PRs across several gated repos in one self-hosted install, which no
     *  single repo's own contributorOpenPrCap/contributorOpenIssueCap can see. Unset/invalid falls back to a
     *  real default (20) rather than "no cap" (#4511) -- set to the literal string "off" for the old
     *  unconditional-no-cap behavior. Checked IN ADDITION TO (not instead of) the existing per-repo caps, in the
     *  same contributor_cap short-circuit (src/settings/agent-actions.ts). A positive integer string (e.g. "20");
     *  see src/settings/global-contributor-cap.ts for parsing. */
    GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP?: string;
    /** Same shape as {@link GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP}, but for a CONFIRMED official Gittensor miner
     *  specifically (#4511) -- a verified miner identity gets this cap instead of the human one, since a
     *  legitimate fleet spread across many repos in one install is expected to run more concurrent open items
     *  than a single human contributor. Unset/invalid falls back to a higher real default (50); "off" exempts
     *  confirmed miners from the install-wide cap entirely while humans stay capped. */
    GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP_MINER?: string;
    /** Install-wide default for the per-repo contributorCapCancelCi setting (#2462): "true"/"1"/"yes"/"on"
     *  (case-insensitive) enables cancelling in-flight CI runs on a contributor_cap close for every repo that
     *  hasn't explicitly configured its own value. Unset/blank/anything else = off (the existing behavior). A
     *  repo's own `contributorCapCancelCi` (DB or `.gittensory.yml`) always takes precedence over this. */
    CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT?: string;
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
    /** Repos the shared GITTENSORY_MCP_TOKEN may propose/decide/manage actions on (comma/whitespace `owner/repo`
     *  list, or `*`/`all` for every repo). Unset ⇒ none — GITTENSORY_MCP_TOKEN is a shared, end-user-obtainable
     *  credential, so it must not implicitly actuate on every installed repo (#2253). */
    MCP_ACTUATION_REPO_ALLOWLIST?: string;
    /** Repos the shared GITTENSORY_MCP_TOKEN may READ via MCP tools (repo context, issue quality, watch
     *  subscriptions) — comma/whitespace `owner/repo` list, or `*`/`all` for every repo AND for the
     *  non-repo-scoped contributor/operator tools (another contributor's private data, fleet analytics). Unset
     *  ⇒ none. A separate allowlist from MCP_ACTUATION_REPO_ALLOWLIST so read and write trust can differ (#2455). */
    MCP_READ_REPO_ALLOWLIST?: string;
    /** Shared bearer secret required by the hosted Orb ingest collector. */
    ORB_INGEST_TOKEN?: string;
    /** AES-256-GCM master secret for maintainer BYOK provider keys (encrypt/decrypt at rest). A Worker/self-host
     *  secret, never a public var. When absent, BYOK is unavailable and review uses the configured instance
     *  reviewer when available. */
    TOKEN_ENCRYPTION_SECRET?: string;
    /** Convergence (Stage D): when truthy, the public PR comment is rendered by the unified-comment bridge
     *  (ONE in-place comment in the converged shape) instead of the legacy `buildPublicPrIntelligenceComment`
     *  panel. Default OFF — unset/false keeps the legacy panel byte-identical. */
    GITTENSORY_REVIEW_UNIFIED_COMMENT?: string;
    /** Inline comments (#inline-comments): when truthy (AND the repo is in GITTENSORY_REVIEW_REPOS AND the repo's
     *  `.gittensory.yml` sets `review.inline_comments: true`), the AI reviewer ALSO leaves quiet, NON-BLOCKING
     *  inline comments on specific changed lines, layered on top of the decision summary. Default OFF —
     *  unset/false keeps the review path byte-identical (the model is never asked for inline findings). */
    GITTENSORY_REVIEW_INLINE_COMMENTS?: string;
    /** Fix-handoff blocks (#2176, config slice of #1962): when truthy (AND the repo is in GITTENSORY_REVIEW_REPOS
     *  AND the repo's `.gittensory.yml` sets `review.fixHandoff: true`), a review finding is ALSO rendered as a
     *  structured, machine-readable "apply this fix" block (src/review/fix-handoff-render.ts) for the
     *  contributor's OWN local agent to consume — content only, no server-side write, no execution. Default
     *  OFF — unset/false keeps the review path byte-identical (no block is ever built). */
    GITTENSORY_REVIEW_FIX_HANDOFF?: string;
    /** Convergence (safety): when truthy, the ported safety scan runs in the review path — (1) untrusted PR
     *  title/body/diff is defanged (prompt-injection neutralized) before it reaches the AI reviewer, and (2)
     *  the PR diff is scanned for leaked secrets, surfacing a `secret_leak` blocker. Default OFF —
     *  unset/false keeps the review path byte-identical (no new branch is taken). */
    GITTENSORY_REVIEW_SAFETY?: string;
    /** Convergence (visual capture): when truthy, the review path captures a before/after screenshot for
     *  PRs that touch WEB-VISIBLE files (frontend pages / public OG images — see review/visual/paths.ts
     *  isVisualPath). "before" = production (PUBLIC_SITE_ORIGIN); "after" = the PR's preview deploy. Each shot
     *  is rendered via the optional BROWSER binding, stored through REVIEW_AUDIT when configured, and embedded
     *  in the unified PR comment as a "Visual preview" table — served either from this instance's own PUBLIC
     *  /gittensory/shot route, or, when REVIEW_AUDIT_S3_PUBLIC_URL is set, directly from the operator's own
     *  S3-compatible bucket instead (see src/selfhost/s3-blob-store.ts). Self-host equivalents are
     *  BROWSER_WS_ENDPOINT + (REVIEW_AUDIT_DIR or the REVIEW_AUDIT_S3_* bucket vars); degrades gracefully
     *  (placeholders / dashes) without them. Backend .ts/.md/.json/.py PRs NEVER trigger capture. Capture runs
     *  for a repo ONLY IF this flag is ON *AND* the repo is in GITTENSORY_REVIEW_REPOS (the per-repo cutover
     *  allowlist) — see review/visual-wire.ts screenshotsAllowed. Default OFF — unset/false captures nothing
     *  (no render, no audit write, no comment change) so the review path is byte-identical to today. */
    GITTENSORY_REVIEW_SCREENSHOTS?: string;
    /** Convergence (grounding): when truthy, the AI reviewer prompt is GROUNDED — the PR's finished CI status
     *  + the FULL post-change content of the changed files are appended so a non-frontier model verifies its
     *  claims against reality instead of predicting CI / flagging symbols defined just outside the hunk.
     *  Default OFF — unset/false keeps the reviewer prompt byte-identical and makes no extra GitHub fetch. */
    GITTENSORY_REVIEW_GROUNDING?: string;
    /** Convergence (e2eTests, #4190/#4189): master kill-switch for the opt-in, maintainer-triggered AI-generated
     *  E2E test coverage feature. Default OFF — unset/false the feature is never active for any repo regardless
     *  of a per-repo `features.e2eTests` override. */
    GITTENSORY_REVIEW_E2E_TESTS?: string;
    /** #one-shot-review-cadence: the operator's FLEET-WIDE default for AI review re-trigger cadence, consulted
     *  only when a repo's `.gittensory.yml review.auto_review.cadence` is unset (a per-repo value always wins
     *  regardless of this flag — see resolveAiReviewCadence). Default OFF (unset/false) ⇒ "one_shot": the
     *  AI-generated content (main review, slop advisory, linked-issue satisfaction) freezes after its first
     *  pass for every repo, and only an explicit maintainer retrigger spends a fresh call. Truthy ⇒
     *  "continuous": the traditional behavior where every push/CI-completion/sweep trigger re-runs AI content
     *  generation, for operators who prefer that over one-shot. Never affects the deterministic gate (CI
     *  status, mergeability, static-rule blockers), which always re-evaluates regardless of this flag. */
    GITTENSORY_REVIEW_CONTINUOUS?: string;
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
    /** Self-heal: when truthy, an hourly watchdog scans the SAME acting-autonomy repo set the scheduled regate
     *  sweep covers for a repo whose sweep marker hasn't advanced despite having open PRs to regate, emits a
     *  structured `sweep_liveness_stale` log (Sentry-visible), and re-enqueues a targeted `agent-regate-sweep`
     *  for just that repo. Default OFF — unset/false means the cron tick enqueues NO watchdog job (does no new
     *  work), so the worker is byte-identical to today. */
    GITTENSORY_SWEEP_WATCHDOG?: string;
    /** Self-heal: when truthy, a short-interval cron list-diffs GitHub's open PR numbers against the local
     *  table for every acting-autonomy repo and catches up (fetch + upsert + regate) any PR number GitHub has
     *  that the local table doesn't — a silently-lost "opened" webhook, caught within minutes instead of the
     *  6-hour backfillRegisteredRepositories freshness window. Default OFF — unset/false means the cron tick
     *  enqueues NO reconciliation job, so the worker is byte-identical to today. */
    GITTENSORY_PR_RECONCILIATION?: string;
    /** Convergence (RAG retrieval): when truthy, the AI reviewer prompt gains a RELEVANT EXISTING CODE / DOCS
     *  section — at review time the codebase vector index is queried for code/docs semantically related to the
     *  PR's changed files (callers, related modules, existing conventions) and appended as additive reference
     *  context, exactly like grounding (see review/rag-wire). Default OFF — unset/false performs NO retrieval,
     *  uses NO adapter, makes NO vector query, and keeps the reviewer prompt byte-identical (the new branch is
     *  unreachable when off). Even when ON, retrieval is INERT until the self-host vector index is populated for
     *  the repo (a cold/missing index degrades to no context). */
    GITTENSORY_REVIEW_RAG?: string;
    /** Deterministic impact map (#2184, part of #1971): operator-level kill-switch, ANDed with the per-repo
     *  `.gittensory.yml review.impact_map` opt-in (see review/impact-map-wire's isImpactMapEnabled /
     *  shouldComputeImpactMap). Default OFF — unset/false performs NO symbol extraction, NO RAG query, and adds
     *  NO comment/prompt section, byte-identical to today. */
    GITTENSORY_REVIEW_IMPACT_MAP?: string;
    /** Repo quality-culture profile (#2995): when truthy, the AI reviewer prompt gains an ADDITIVE "REPO
     *  QUALITY-CULTURE PROFILE" reference block — typical merged-PR size + common accepted labels, derived
     *  deterministically from this repo's OWN `recent_merged_pull_requests` history (see
     *  review/repo-culture-profile.ts + repo-culture-profile-wire.ts). Also requires the per-repo
     *  `.gittensory.yml` `review.culture_profile: true` opt-in — this is the global kill-switch only. Default
     *  OFF — unset/false performs NO extra D1 read and keeps the reviewer prompt byte-identical (the new branch
     *  is unreachable when off). ADVISORY GROUNDING ONLY: never a gate/scoring input. */
    GITTENSORY_REVIEW_CULTURE_PROFILE?: string;
    /** Review memory (#2179, part of #1964): operator-level kill-switch for repeat-false-positive suppression,
     *  ANDed with the per-repo `.gittensory.yml review.memory` opt-in (see review/review-memory-wire's
     *  isReviewMemoryEnabled / shouldApplyReviewMemory). Default OFF — unset/false performs NO suppression-
     *  store read and NO matching, byte-identical to today. ADVISORY-ONLY: never applied to gate blockers. */
    GITTENSORY_REVIEW_MEMORY?: string;
    /** Review-enrichment service (REES): when truthy, the self-host review engine POSTs the PR diff/files to
     *  REES and splices any public-safe brief into the AI reviewer prompt. Requires REES_URL and the repo in
     *  GITTENSORY_REVIEW_REPOS. REES_ANALYZERS is an optional exact comma-list; unset/"all"/"*" lets REES run its
     *  full registry. REES_FORWARD_GITHUB_TOKEN defaults off and must be explicitly enabled before
     *  GitHub read tokens are included in the REES request. REES_SHARED_SECRET is a bearer secret and must never be committed. */
    GITTENSORY_REVIEW_ENRICHMENT?: string;
    REES_URL?: string;
    REES_SHARED_SECRET?: string;
    REES_TIMEOUT_MS?: string;
    REES_ANALYZERS?: string;
    REES_PROFILE?: string;
    REES_FORWARD_GITHUB_TOKEN?: string;
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
    /** Maintainer recap digest (#1963, #2248): when truthy, a cross-repo RecapReport -- gittensory's OWN
     *  gate-precision + outcome-calibration data folded across every scanned repo (buildMaintainerRecap,
     *  #2239) -- is delivered to Discord on a cron cadence. GITTENSORY_RECAP_CADENCE ("daily" | "weekly",
     *  default "weekly"; an invalid value falls back to "weekly") picks how often; GITTENSORY_RECAP_HOUR
     *  (0-23, default 14) and GITTENSORY_RECAP_DAY (0-6, Sunday=0, default 1/Monday, only consulted when
     *  weekly) pick when, so the tick fires at most once per period. Default OFF -- unset/false means the
     *  cron enqueues NO recap job, byte-identical to today. See src/review/maintainer-recap-wire.ts. */
    GITTENSORY_MAINTAINER_RECAP?: string;
    GITTENSORY_RECAP_CADENCE?: string;
    GITTENSORY_RECAP_HOUR?: string;
    GITTENSORY_RECAP_DAY?: string;
    /** #1941: route the live CI aggregate (the gate's check/status read) through ONE GraphQL statusCheckRollup
     *  query instead of the paginated /check-runs + /status + /check-suites REST reads, moving that hot path onto
     *  the separate GraphQL rate-limit bucket. Default OFF (byte-identical, proven REST aggregate); when ON the
     *  GraphQL path reuses the REST-resolved required contexts and falls back to REST on any error, unexpected
     *  shape, or >100 rollup contexts. See fetchLiveCiAggregateViaGraphQl. */
    GITHUB_STATUS_ROLLUP_GRAPHQL?: string;
    /** Convergence (#issue-coding-plan): the `@gittensory plan` command. Default OFF — `@gittensory plan` falls
     *  through to the existing mention path, so the worker is byte-identical to today. Hosted planning is retired
     *  with the Cloudflare AI binding; self-host can run planning through the configured AI provider. */
    GITTENSORY_REVIEW_PLANNER?: string;
    /** Proof of Power (#1059): when truthy, the unauthenticated `GET /v1/public/stats` endpoint serves the public
     *  homepage counter — computed LIVE from the public review ledger behind a 60s cache, so it stays current as
     *  new reviews land. Default OFF — unset/false 404s the endpoint, so the
     *  worker is byte-identical to today. Exposes review-disposition counts + a reversal-grounded accuracy
     *  percentage + an estimated-time-saved figure ONLY — never PR content, authors, scores, or reward internals.
     *  See review/public-stats.ts. */
    GITTENSORY_PUBLIC_STATS?: string;
    /** Proof of Power (#1059): comma-separated allowlist of repo full-names ("owner/repo") whose OWN historical
     *  review ledger (audit_events "published a review surface" + pull_requests terminal state) counts toward
     *  the public stats counter. DELIBERATELY SEPARATE from GITTENSORY_REVIEW_REPOS (the live per-PR-feature
     *  cutover allowlist) even though both once held the same value: after the repos below moved to self-host,
     *  GITTENSORY_REVIEW_REPOS correctly went empty (the central worker no longer live-reviews them), but the
     *  historical rows this worker already wrote for them are still real and still safe to publish — a bug once
     *  reused GITTENSORY_REVIEW_REPOS for this too, so an empty cutover allowlist silently zeroed the ENTIRE
     *  public counter, including the unrelated cross-fleet self-hoster aggregate (getOrbGlobalStats), which does
     *  not depend on this var at all. Default "" (unset) → the own-ledger side reports zero (fails safe, same
     *  privacy stance as before) but the Orb aggregate still reports normally. See review/public-stats.ts. */
    GITTENSORY_PUBLIC_STATS_REPOS?: string;
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
    /** Open-PR file-path collision (#2653): when truthy, a live PR review enriches its own and its open
     *  siblings' `changedFiles` from the `pull_request_files` cache (a plain D1 read — no extra GitHub calls)
     *  before building the collision report, so two independently-open PRs touching the same file are flagged
     *  the same way two title-similar PRs already are. A contributor's own two PRs sharing a file are never
     *  flagged (see the same-author guard in buildCollisionReport). Default OFF — unset/false leaves every
     *  PullRequestRecord's changedFiles unset, byte-identical to today. See src/signals/engine.ts prItem. */
    GITTENSORY_OPEN_PR_FILE_COLLISION?: string;
    /** D1 size/row-count observability probe (#3810): the Cloudflare account id that owns the D1 database to
     *  monitor. Presence of this AND the two vars below IS the enablement switch (see isD1SizeProbeEnabled,
     *  src/selfhost/d1-size-probe.ts) -- unset/blank ⇒ the probe never runs, byte-identical to today. Most
     *  self-host operators run their own SQLite/Postgres backend and have no Cloudflare D1 to watch; this is
     *  for whichever deployment owns a real D1 worth monitoring (including gittensory's own central cloud
     *  database, the one that hit its ~10GB cap on 2026-07-06). */
    CLOUDFLARE_D1_MONITOR_ACCOUNT_ID?: string;
    /** The D1 database id (uuid) to monitor. See CLOUDFLARE_D1_MONITOR_ACCOUNT_ID. */
    CLOUDFLARE_D1_MONITOR_DATABASE_ID?: string;
    /** A Cloudflare API token with read access to D1 for the account above (a scoped, read-only custom
     *  token is sufficient — this probe never writes). A secret — never commit a real value. See
     *  CLOUDFLARE_D1_MONITOR_ACCOUNT_ID. */
    CLOUDFLARE_D1_MONITOR_API_TOKEN?: string;
  }
}

export {};
