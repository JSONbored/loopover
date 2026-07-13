# Gittensory Miner UI

Local, read-only dashboard shell for a laptop or fleet miner instance. It mirrors the main
`apps/gittensory-ui/` tooling versions (React 19, TanStack Router, Vite, Tailwind v4) but intentionally
does **not** adopt that app's Cloudflare Worker deploy model or `@lovable.dev/*` scaffold dependency.

The miner package invariant is client-side only with no required phone-home to boot
(`packages/gittensory-miner/DEPLOYMENT.md`). This app is a plain Vite dev server / static build that a
local miner CLI can serve later — not a Wrangler deploy target.

Phase 6 data views (run history, portfolio cards) land in follow-up issues after this empty shell.

## Local API

The dev/preview server exposes a few strictly read-only `GET` endpoints that bridge the miner's on-disk
`node:sqlite` stores to a browser client (each returns `[]`/an empty summary on a fresh install without creating
any file):

| Endpoint               | Serves                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| `/api/run-state`       | `miner_run_state` rows (#4305), loopback-only.                              |
| `/api/portfolio-queue` | Portfolio-queue status counts, aggregated server-side (#4306 / #4846).      |
| `/api/discovery`       | Latest ranked discovery candidate per issue (#4859), loopback-only. Powers the contributor miner extension's live-fetch mode; reconstructed from the event ledger's `discovered_issue` events. |

## Configuration

| Env var                     | Required | Description                                                                                                                                                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MINER_UI_GRAFANA_URL` | No       | If set (and non-empty), renders a footer link to your ORB/Grafana dashboard at this URL. Unset ⇒ no link. Must be `VITE_`-prefixed so Vite exposes it to the client bundle. It is a plain navigational link — no token or credential is ever appended. |
