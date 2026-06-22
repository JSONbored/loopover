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
    /** Convergence (port): public OAuth draft-submission flow ported from reviewbot. When truthy, the
     *  /v1/drafts endpoints accept a contributor draft -> GitHub OAuth -> fork PR against the content repo.
     *  Default OFF — unset/false makes every draft endpoint 404 and writes nothing (byte-identical worker). */
    REVIEWBOT_DRAFT?: string;
    /** owner/repo the draft fork PR targets (defaults to the awesome-claude content repo when unset). */
    DRAFT_PUBLIC_REPO?: string;
    /** Base branch the draft PR opens against (defaults to "main"). */
    DRAFT_BASE_REF?: string;
    /** AES-256-GCM secret used to encrypt the short-lived contributor OAuth token at rest. A Worker
     *  secret (`wrangler secret put`). When absent, the draft create/callback endpoints return 503. */
    DRAFT_TOKEN_ENCRYPTION_SECRET?: string;
  }
}

export {};
