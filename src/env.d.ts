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
  }
}

export {};
