# Gittensory Miner UI

Local, read-only dashboard shell for a laptop or fleet miner instance. It mirrors the main
`apps/gittensory-ui/` tooling versions (React 19, TanStack Router, Vite, Tailwind v4) but intentionally
does **not** adopt that app's Cloudflare Worker deploy model or `@lovable.dev/*` scaffold dependency.

The miner package invariant is client-side only with no required phone-home to boot
(`packages/gittensory-miner/DEPLOYMENT.md`). This app is a plain Vite dev server / static build that a
local miner CLI can serve later — not a Wrangler deploy target.

Phase 6 data views (run history, portfolio cards) land in follow-up issues after this empty shell.
