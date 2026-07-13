# Gittensory Miner Extension

Contributor-facing browser extension for GitHub **issue** pages. It is intentionally separate from
[`apps/gittensory-extension/`](../gittensory-extension/) (the **Maintainer Overlay**), which injects private PR/issue
context for maintainers.

## What it does

- Manifest V3 with issue-page `content_scripts`
- `background.js` service worker + `content.js` message-passing
- Read-only opportunity badge (score/tier + short why) for watched repositories
- Options page for watched repos and a local ranked-candidate cache, populated by a live fetch from the local
  miner-ui (paste is kept as a fallback)

The badge surfaces the same ranked signal as `packages/gittensory-miner/lib/opportunity-ranker.js` by reading
pre-ranked candidates from browser local storage. It never writes to GitHub and omits itself when no ranked signal is
available for the current issue.

## Local ranked cache

The extension looks up the current issue in `chrome.storage.local.rankedCandidates`, stored alongside a
`chrome.storage.local.rankedCandidatesSavedAt` timestamp updated on every write. When no ranked signal is cached for
the current issue, the badge degrades gracefully by staying hidden. The badge itself shows a "last synced"
relative-time label (mirroring ORB's shared `RefreshMeta` component's thresholds) so a contributor can tell how stale
the data is; the label is omitted entirely for a cache saved before this field existed.

### Live fetch (primary) — #4859

The options page's **Fetch live from miner** button pulls ranked candidates straight from your local miner-ui's
read-only [`GET /api/discovery`](../gittensory-miner-ui/) endpoint and writes them into the cache. The default
target is `http://localhost:5174` (miner-ui's fixed dev port); the **Miner UI base URL** field lets you point at a
different loopback port, and is validated to `http://localhost` / `http://127.0.0.1` only. The fetch runs from the
options page — a `chrome-extension://` origin holding the manifest's `http://localhost/*` + `http://127.0.0.1/*`
host permissions — so the browser bypasses CORS without the miner-ui having to emit any `Access-Control-*` headers.

This closed the "localhost-reachability gap": before it, the miner's ranked output lived only in a local SQLite
ledger and `discover --json` stdout, with no channel a browser surface could read. The endpoint reconstructs the
ranked list from the append-only event ledger's `discovered_issue` events, so it exposes exactly what `discover`
already persisted locally, loopback-only.

### Paste (fallback)

When the miner-ui is not running, you can still paste JSON from a `discover --json` run into the **Ranked candidates
JSON (paste fallback)** box and save. This is the original workflow, kept as a fallback for laptop-mode installs.

The extension does not request the `unlimitedStorage` permission, so a paste is rejected with a clear error before
being parsed or saved once it exceeds a conservative size bound well under `chrome.storage.local`'s default 10 MiB
quota, instead of silently failing to save or leaving storage partially written.
