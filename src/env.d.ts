declare global {
  interface Env {
    DB: D1Database;
    JOBS: Queue;
    RATE_LIMITER?: DurableObjectNamespace;
    AI?: Ai;
    PUBLIC_API_ORIGIN?: string;
    AI_SUMMARIES_ENABLED?: string;
    AI_PUBLIC_COMMENTS_ENABLED?: string;
    WORKERS_AI_SUMMARY_MODEL?: string;
    AI_DAILY_NEURON_BUDGET?: string;
    AI_MAX_OUTPUT_TOKENS?: string;
    ADMIN_GITHUB_LOGINS?: string;
    GITHUB_WEBHOOK_SECRET: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_SLUG: string;
    GITHUB_OAUTH_CLIENT_ID?: string;
    GITTENSOR_REGISTRY_URL: string;
    GITHUB_PUBLIC_TOKEN?: string;
    GITTENSORY_API_TOKEN: string;
    GITTENSORY_MCP_TOKEN: string;
    INTERNAL_JOB_TOKEN: string;
  }
}

export {};
