declare global {
  interface Env {
    DB: D1Database;
    JOBS: Queue;
    RATE_LIMITER?: DurableObjectNamespace;
    AI?: Ai;
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
    ADMIN_GITHUB_LOGINS?: string;
    GITHUB_WEBHOOK_SECRET: string;
    GITHUB_WEBHOOK_MAX_BODY_BYTES?: string;
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
    GITTENSORY_AUTO_FILE_DRIFT_ISSUES?: string;
    GITTENSORY_DRIFT_ISSUE_REPO?: string;
    GITTENSORY_DRIFT_ISSUE_TOKEN?: string;
    GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN?: string;
    PRODUCT_USAGE_HASH_SALT?: string;
    GITTENSORY_API_TOKEN: string;
    GITTENSORY_MCP_TOKEN: string;
    INTERNAL_JOB_TOKEN: string;
    /** AES-256-GCM master secret for maintainer BYOK provider keys (encrypt/decrypt at rest). A Worker
     *  secret (`wrangler secret put`), never a public var. When absent, BYOK is unavailable and the AI
     *  review silently falls back to free Workers AI. */
    TOKEN_ENCRYPTION_SECRET?: string;
    RATE_LIMIT_TRUSTED_PROXIES?: string;
    RATE_LIMIT_TRUSTED_PROXY_COUNT?: string;
    /** Convergence (Stage D): when truthy, the public PR comment is rendered by the unified-comment bridge
     *  (ONE in-place comment in the converged shape) instead of the legacy `buildPublicPrIntelligenceComment`
     *  panel. Default OFF — unset/false keeps the legacy panel byte-identical. */
    UNIFIED_REVIEW_COMMENT?: string;
    /** Convergence (safety): when truthy, the ported safety scan runs in the review path — (1) untrusted PR
     *  title/body/diff is defanged (prompt-injection neutralized) before it reaches the AI reviewer, and (2)
     *  the PR diff is scanned for leaked secrets, surfacing a `secret_leak` blocker. Default OFF —
     *  unset/false keeps the review path byte-identical (no new branch is taken). */
    REVIEWBOT_SAFETY?: string;
    /** Convergence (grounding): when truthy, the AI reviewer prompt is GROUNDED — the PR's finished CI status
     *  + the FULL post-change content of the changed files are appended so a non-frontier model verifies its
     *  claims against reality instead of predicting CI / flagging symbols defined just outside the hunk.
     *  Default OFF — unset/false keeps the reviewer prompt byte-identical and makes no extra GitHub fetch. */
    REVIEWBOT_GROUNDING?: string;
  }
}

export {};
