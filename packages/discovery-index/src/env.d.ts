// Wrangler secrets don't appear in wrangler.jsonc (never committed) so `wrangler types` can't discover
// their names -- declared here via ambient global merge with the generated Env interface
// (worker-configuration.d.ts), mirroring src/env.d.ts's pattern in the main app at the repo root. Set both
// via `npx wrangler secret put <name>` before first deploy; never given a real value in this repo.
// This file has a top-level `export {}` (making it a module), so both augmentations below must live
// inside `declare global` -- a bare top-level `declare namespace Cloudflare` here would be scoped to this
// module only and would NOT merge with worker-configuration.d.ts's script-scope `Cloudflare` namespace.
declare global {
  interface Env {
    /** Bearer secret required to call this service's own /v1/discovery-index/* routes. */
    DISCOVERY_INDEX_SHARED_SECRET: string;
    /** This service's own GitHub token, isolated from any other component's. */
    DISCOVERY_INDEX_GITHUB_TOKEN: string;
    /** PostHog PROJECT token (#8289) -- error capture. PENDING #7875 (a real loopover-owned PostHog project):
     *  once provisioned, this graduates to a plain wrangler.jsonc `vars` entry (write-only, safe to commit)
     *  and this declaration is removed. Declared here only so it type-checks in the meantime; optional and
     *  no-op when unset. */
    POSTHOG_API_KEY?: string;
    /** PostHog ingestion host override (EU region). PENDING #7875, see POSTHOG_API_KEY above. */
    POSTHOG_HOST?: string;
    /** PostHog capture `environment` tag override. PENDING #7875. */
    POSTHOG_ENVIRONMENT?: string;
    /** The deploy's PostHog release identifier -- deliberately NOT a static wrangler.jsonc var since it must
     *  change every deploy; set via `wrangler deploy --var POSTHOG_RELEASE:...`. PENDING #7875. */
    POSTHOG_RELEASE?: string;
    /** A PostHog PERSONAL API key (error-tracking write + organization read scopes) -- genuinely sensitive,
     *  used only for source-map upload via posthog-cli. Optional: upload-sourcemaps.ts's PostHog step no-ops
     *  with a log line when unset, never fails the boot. PENDING #7875. */
    POSTHOG_CLI_API_KEY?: string;
    /** The PostHog project's numeric id (not a secret -- a plain identifier), required alongside
     *  POSTHOG_CLI_API_KEY for source-map upload. PENDING #7875. */
    POSTHOG_CLI_PROJECT_ID?: string;
    /** posthog-cli host override (EU region), mirroring POSTHOG_HOST for the CLI's own separate auth config. PENDING #7875. */
    POSTHOG_CLI_HOST?: string;
  }

  // `import { env } from "cloudflare:workers"` (used in worker.ts's Container class field initializers,
  // which run outside the fetch handler's own `env` parameter scope) is typed against `Cloudflare.Env`
  // specifically, not the bare `Env` above -- both need the same augmentation.
  namespace Cloudflare {
    interface Env {
      DISCOVERY_INDEX_SHARED_SECRET: string;
      DISCOVERY_INDEX_GITHUB_TOKEN: string;
      POSTHOG_API_KEY?: string;
      POSTHOG_HOST?: string;
      POSTHOG_ENVIRONMENT?: string;
      POSTHOG_RELEASE?: string;
      POSTHOG_CLI_API_KEY?: string;
      POSTHOG_CLI_PROJECT_ID?: string;
      POSTHOG_CLI_HOST?: string;
    }
  }
}

export {};
