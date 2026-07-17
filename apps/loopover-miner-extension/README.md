# LoopOver Miner Extension

Contributor-facing browser extension for GitHub **issue** pages. It is intentionally separate from
[`apps/loopover-extension/`](../loopover-extension/) (the **Maintainer Overlay**), which injects private PR/issue
context for maintainers.

## What it does

- Manifest V3 with issue-page `content_scripts`
- `background.js` service worker + `content.js` message-passing
- Read-only opportunity badge (score/tier + short why) for watched repositories
- Options page for watched repos and a local ranked-candidate cache

The badge surfaces the same ranked signal as `packages/loopover-miner/lib/opportunity-ranker.js` by reading
pre-ranked candidates from browser local storage. It never writes to GitHub and omits itself when no ranked signal is
available for the current issue.

## Local ranked cache

Laptop-mode installs can paste JSON from a miner `discover` run into the options page. The extension stores that list in
`chrome.storage.local.rankedCandidates`, alongside a `chrome.storage.local.rankedCandidatesSavedAt` timestamp updated on
every save, and looks up the current issue there. When no ranked signal is cached for the current issue, the badge
degrades gracefully by staying hidden. The badge itself shows a "last synced" relative-time label (mirroring ORB's
shared `RefreshMeta` component's thresholds) so a contributor can tell how stale the pasted data is; the label is
omitted entirely for a cache saved before this field existed.

The extension does not request the `unlimitedStorage` permission, so a paste is rejected with a clear error before
being parsed or saved once it exceeds a conservative size bound well under `chrome.storage.local`'s default 10 MiB
quota, instead of silently failing to save or leaving storage partially written.

## Test coverage

`npm test` runs with `--coverage` enabled (v8 provider) and enforces `vitest.config.ts`'s
`coverage.thresholds` — a measured baseline (#4865), not an aspirational target. The suite imports
`background.js`, `opportunity-badge.js`, and `toolbar-badge.js` directly (via the existing
`__LOOPOVER_MINER_EXTENSION_TEST__` hook) so v8 can attribute coverage; the root `test/unit/miner-*.test.ts`
files remain as broader behavior tests through the `node:vm` harness.

`content.js`'s import-time logic (`test/content.test.ts`, #6189) and `options.js`'s pure helpers
(`test/options.test.ts`, #7008) are now behavior-tested through the same `__LOOPOVER_MINER_EXTENSION_TEST__`
hook: each imports the module on a non-mounted path (a non-issue `location`, a null-returning `document`), so
its DOM-independent logic runs without any jsdom mount harness. What genuinely still needs a real DOM harness —
and stays deferred — is the full options-page/content-script UI: the form-submit and live-sync event handlers
that only run once the page is actually mounted. Those files are not yet in `coverage.include` (their mounted
paths would report uncovered without the harness); add them and raise thresholds per-PR as that UI gets covered.

## Host permissions

`manifest.json` grants `https://github.com/*` (for the issue-page content script) plus loopback host permissions —
`http://localhost/*` and `http://127.0.0.1/*` — so the extension can reach the operator's own local miner-ui API
(#4860). Chrome match patterns cannot pin a port, so `http://localhost/*` is the narrowest grant the platform
allows; `https` is intentionally omitted because the local miner-ui dev server is plain HTTP. This is the enabling
permission for live-fetching ranked candidates from the local miner-ui instead of pasting them.
