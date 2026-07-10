# Gittensory Miner Extension

Contributor-facing browser extension for GitHub **issue** pages. It is intentionally separate from
[`apps/gittensory-extension/`](../gittensory-extension/) (the **Maintainer Overlay**), which injects private PR/issue
context for maintainers.

## What it does

- Manifest V3 with issue-page `content_scripts`
- `background.js` service worker + `content.js` message-passing
- Read-only opportunity badge (score/tier + short why) for watched repositories
- Options page for watched repos and a local ranked-candidate cache

The badge surfaces the same ranked signal as `packages/gittensory-miner/lib/opportunity-ranker.js` by reading
pre-ranked candidates from browser local storage. It never writes to GitHub and omits itself when no ranked signal is
available for the current issue.

## Local ranked cache

Laptop-mode installs can paste JSON from a miner `discover` run into the options page. The extension stores that list in
`chrome.storage.local.rankedCandidates` and looks up the current issue there. A discovery-index URL can be saved for a
future hosted client path; it is not read yet, so when only unranked hosted metadata would be available the badge
degrades gracefully by staying hidden.
