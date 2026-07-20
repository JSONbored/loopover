# @loopover/control-plane

Hosting control-plane package for LoopOver ORB/AMS tenant lifecycle (#7173 / #7180 / #7524).

This package hosts **orchestration only**: `provisionTenant()` / `deprovisionTenant()` run against an
injectable `TenantProvisioningDriver`. The in-tree driver is a fake/in-memory implementation for
tests. Real Cloudflare Containers / Postgres providers are intentionally out of scope until the
Postgres-provider decision on #7180 lands.

Secrets injection goes through the `#7174` broker-shaped `TenantSecretBroker` seam (typed
`secretType`), not a hand-rolled credentials path.

Codecov note: this package is a standalone (non-workspace) tree like `review-enrichment/`. It is
**not** under root `vitest.config.ts` `coverage.include` (`src/**`), so Codecov's patch gate does
not apply numerically here — coverage is enforced by this package's own `npm test` suite.
