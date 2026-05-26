# Support

Use GitHub issues for public, non-sensitive support:

- MCP install, auth, or local branch-analysis problems
- GitHub App install health, permissions, or comment/label behavior
- API contract, data freshness, or signal-quality bugs
- documentation gaps

Do not post secrets, private keys, webhook payload secrets, wallet details, hotkeys, coldkeys,
raw session tokens, private maintainer evidence, or private scoring output in public issues.

For security issues, use the guidance in `SECURITY.md`.

## Useful Issue Details

- Gittensory MCP version from `gittensory-mcp status`
- command used, with tokens and local paths removed
- sanitized error message
- repository owner/name when relevant
- whether the problem is MCP, API, GitHub App, docs, or data freshness

## Expected Response Posture

Gittensory is maintained as a backend and agent-integration project. Support should keep the same
boundaries as the product: no public wallet data, no raw trust scores, no public reward estimates,
and no source-code upload by default.
