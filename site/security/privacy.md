# Privacy And Security

Gittensory handles contribution intelligence, not wallets or private source code.

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

The GitHub App is advisory-only. It does not auto-label, close, merge, or rewrite contributor work.
