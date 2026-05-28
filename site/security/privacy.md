# Privacy And Security

Gittensory handles contribution intelligence, not wallets or private source code.

## Docs Analytics

The public docs site may use privacy-preserving Umami analytics to count traffic and high-level page usage. Analytics are configured only at build time, do not run in local docs builds by default, and are separate from the MCP/API product.

## No PAT Storage

MCP login uses GitHub OAuth Device Flow. The backend exchanges the GitHub token for a Gittensory session token and stores only the hashed Gittensory token server-side.

## No Source Upload

Local MCP branch analysis sends metadata only:

- repo full name
- branch name
- base and head refs
- changed file paths
- additions and deletions
- linked issue references
- commit messages
- validation summaries

Source contents are not uploaded in v1. `GITTENSORY_UPLOAD_SOURCE=true` fails closed.

## Optional Workers AI

Gittensory's scoring and recommendations are deterministic. Cloudflare Workers AI can be enabled later as a quota-gated summarization layer, but it receives only compact signal metadata, not source code. If the AI layer is disabled, unavailable, or over budget, Gittensory falls back to deterministic templates.

## Public Output Boundaries

Public comments and public-safe PR packets must not include:

- wallets
- hotkeys
- raw trust scores
- public score estimates
- public reward estimates
- farming language
- public shaming

Private API and MCP responses can include scoreability and reward/risk reasoning because they are authenticated private outputs.

## Rate Limiting

Gittensory uses route classes:

- strict: auth routes
- normal: read APIs and MCP tools
- expensive: branch analysis, scoring preview, decision-pack refresh, signal refresh

Rate-limited responses return `429` with retry metadata.

## GitHub App Boundaries

The GitHub App is advisory-only. It can apply a maintainer-configured label to confirmed miner PRs, but it does not close, merge, rewrite, or publicly score contributor work.
