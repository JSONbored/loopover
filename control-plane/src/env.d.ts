// Wrangler secrets don't appear in wrangler.jsonc (never committed) so `wrangler types` can't discover their
// names -- declared here via ambient global merge with the generated Env interface
// (worker-configuration.d.ts), mirroring the main app's own src/env.d.ts pattern (and
// packages/discovery-index/src/env.d.ts's identical one). Set real values via `npx wrangler secret put
// <name>`; never given a real value in this repo.
declare global {
  interface Env {
    /** Admin Bearer token every `/v1/tenants/*` route requires (#7654). Genuinely sensitive -- always a
     *  wrangler secret, never a plain var. */
    ADMIN_TOKEN: string;
    /** Selects the real Neon-backed database driver (#7653) when both this and NEON_PROJECT_ID are set;
     *  createTenantProvisioningDriver falls back to the fake driver otherwise. Genuinely sensitive. */
    NEON_API_KEY?: string;
    /** Same routing-key secret name/shape as the main app's own src/env.d.ts (#7667's PagerDuty mirror) --
     *  grants the ability to trigger a real page, so it's a secret here too, not a plain var. */
    PAGERDUTY_ROUTING_KEY?: string;
    /** This hosted fleet's OWN GitHub App webhook secret (#7181) -- a SEPARATE value from the main app's
     *  ORB_GITHUB_WEBHOOK_SECRET (a different physical service). Unset ⇒ POST /v1/orb/webhook fails every
     *  delivery closed (orb-webhook-router.ts). Genuinely sensitive: whoever holds it can forge a webhook. */
    ORB_WEBHOOK_SECRET?: string;
  }
}

export {};
