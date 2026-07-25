# LoopOver Miner UI

Local, read-only dashboard for a laptop or fleet miner instance. It mirrors the main
`apps/loopover-ui/` tooling versions (React 19, TanStack Router, Vite, Tailwind v4) but intentionally
does **not** adopt that app's Cloudflare Worker deploy model or `@lovable.dev/*` scaffold dependency.

The miner package invariant is client-side only with no required phone-home to boot
(`packages/loopover-miner/DEPLOYMENT.md`). This app is a plain Vite dev server / static build that a
local miner CLI can serve later — not a Wrangler deploy target.

The Phase 6 data views have shipped: an overview summary (`routes/index.tsx`, #4853) alongside dedicated
run-history, portfolio, and ledgers views, each fed by the local read-only `/api/*` endpoints below.

## Configuration

| Env var                     | Required | Description                                                                                                                                                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MINER_UI_GRAFANA_URL` | No       | If set (and non-empty), renders a footer link to your ORB/Grafana dashboard at this URL. Unset ⇒ no link. Must be `VITE_`-prefixed so Vite exposes it to the client bundle. It is a plain navigational link — no token or credential is ever appended. |

## Local API authentication

`/api/*` (run-state, portfolio-queue, ledgers, and any future endpoint under that prefix) requires a
same-origin session cookie — an unauthenticated request is rejected with `401`. The dev/preview server
(`vite-auth.ts`) generates a random token once per process and sets it as an `HttpOnly; SameSite=Strict`
cookie on every response; a browser that has loaded this app's own page (`/`) already carries the cookie
automatically on every subsequent same-origin `fetch()` call, so none of the client-side data fetchers need
to know about it. A request from another local process, or from a different page/origin the user has open
(including a DNS-rebinding attempt), has no way to obtain the cookie and is rejected. There is nothing to
configure — this is always on for both `vite dev` and `vite preview`.

## Running as a persistent service

`npm run dev` is a foreground dev server; it doesn't survive a terminal closing or a reboot. For a
fleet/bare-host operator who wants the dashboard durably available, `npm run build` followed by
`npm run preview` serves the built dashboard **and** its local-SQLite-backed API routes (the
`vite-*-api.ts` plugins register for both `configureServer` and `configurePreviewServer`, so nothing
extra is needed beyond the build step) on port `4174` by default.

[`systemd/loopover-miner-ui.service.example`](../../systemd/loopover-miner-ui.service.example) at
the repo root is a ready-to-adapt persistent unit for this — a companion to
`loopover-miner.service.example` (the loop daemon), not a replacement for it. Its header comment
carries the full install steps. Like the loop daemon, this is a `Type=simple` service, not a `.timer`
job — the dashboard is a long-running HTTP server, not a periodic batch task.

## Test coverage

`npm test` runs with `--coverage` enabled (v8 provider) and enforces `vitest.config.ts`'s `coverage.thresholds`
— a real measured baseline (#4865), not an aspirational target, so CI fails on a genuine regression (e.g. a
large new feature landing with no tests) rather than staying silently unmeasured the way `apps/**` is by
default at the repo root.
