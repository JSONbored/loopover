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
    /** Full Sentry API access (releases, source-map upload) -- unlike SENTRY_DSN/ORG/PROJECT (wrangler.jsonc
     *  `vars`, non-sensitive), this is genuinely sensitive and stays a secret. Optional: upload-sourcemaps.ts
     *  no-ops with a log line when unset, never fails the boot. */
    SENTRY_AUTH_TOKEN?: string;
    /** The deploy's release identifier (loopover-discovery-index@<sha>) -- deliberately NOT a static
     *  wrangler.jsonc var since it must change every deploy; set via `wrangler deploy --var
     *  SENTRY_RELEASE:...` (see wrangler.jsonc's own header comment). Optional: initSentry falls back to
     *  deriving one from SENTRY_COMMIT_SHA, else omits release tagging entirely. */
    SENTRY_RELEASE?: string;
  }

  // `import { env } from "cloudflare:workers"` (used in worker.ts's Container class field initializers,
  // which run outside the fetch handler's own `env` parameter scope) is typed against `Cloudflare.Env`
  // specifically, not the bare `Env` above -- both need the same augmentation.
  namespace Cloudflare {
    interface Env {
      DISCOVERY_INDEX_SHARED_SECRET: string;
      DISCOVERY_INDEX_GITHUB_TOKEN: string;
      SENTRY_AUTH_TOKEN?: string;
      SENTRY_RELEASE?: string;
    }
  }
}

export {};
