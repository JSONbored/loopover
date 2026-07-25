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
    /** Bearer-gates the main app's own `/v1/internal/*` routes (#8066) -- the SAME shared secret value as that
     *  deployment's own INTERNAL_JOB_TOKEN, since this driver is calling those routes as an authenticated
     *  internal caller. Selects the real secret driver (src/secret-driver.ts) together with MAIN_APP_BASE_URL
     *  (a plain var, see wrangler.jsonc); createTenantProvisioningDriver falls back to the fake otherwise.
     *  Genuinely sensitive: whoever holds it can call every internal admin route in the main app. */
    INTERNAL_JOB_TOKEN?: string;
    /** The central PostHog project key (#7876) the hosted fleet reports errors to, provisioned by #7875.
     *  When set, driver-factory.ts threads it into every tenant container (CENTRAL_POSTHOG_KEY_ENV_VAR) so the
     *  self-host image points its own error tracking at the loopover-owned project. Genuinely sensitive:
     *  whoever holds it can write events into the fleet's analytics project. */
    CENTRAL_POSTHOG_KEY?: string;
  }
}

export {};
