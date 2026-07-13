# Gittensory Miner UI

Local, read-only dashboard shell for a laptop or fleet miner instance. It mirrors the main
`apps/gittensory-ui/` tooling versions (React 19, TanStack Router, Vite, Tailwind v4) but intentionally
does **not** adopt that app's Cloudflare Worker deploy model or `@lovable.dev/*` scaffold dependency.

The miner package invariant is client-side only with no required phone-home to boot
(`packages/gittensory-miner/DEPLOYMENT.md`). This app is a plain Vite dev server / static build that a
local miner CLI can serve later — not a Wrangler deploy target.

Phase 6 data views (run history, portfolio cards) land in follow-up issues after this empty shell.

## Configuration

| Env var                     | Required | Description                                                                                                                                                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MINER_UI_GRAFANA_URL` | No       | If set (and non-empty), renders a footer link to your ORB/Grafana dashboard at this URL. Unset ⇒ no link. Must be `VITE_`-prefixed so Vite exposes it to the client bundle. It is a plain navigational link — no token or credential is ever appended. |

## Running as a persistent service

`npm run dev` is a foreground dev server; it doesn't survive a terminal closing or a reboot. For a
fleet/bare-host operator who wants the dashboard durably available, `npm run build` followed by
`npm run preview` serves the built dashboard **and** its local-SQLite-backed API routes (the
`vite-*-api.ts` plugins register for both `configureServer` and `configurePreviewServer`, so nothing
extra is needed beyond the build step) on port `4174` by default.

[`systemd/gittensory-miner-ui.service.example`](../../systemd/gittensory-miner-ui.service.example) at
the repo root is a ready-to-adapt persistent unit for this — a companion to
`gittensory-miner.service.example` (the loop daemon), not a replacement for it. Its header comment
carries the full install steps. Like the loop daemon, this is a `Type=simple` service, not a `.timer`
job — the dashboard is a long-running HTTP server, not a periodic batch task.
