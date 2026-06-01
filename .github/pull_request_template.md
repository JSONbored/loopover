## Summary

-

## Scope

- [ ] This PR is focused and does not mix unrelated backend, UI, MCP, docs, dependency, and deploy changes.
- [ ] This follows `CONTRIBUTING.md` and does not reintroduce GitHub Pages, VitePress, `site/`, or `CNAME`.
- [ ] I linked an issue, or this is small enough that the summary explains why an issue is not needed.

## Validation

- [ ] `git diff --check`
- [ ] `npm run actionlint`
- [ ] `npm run typecheck`
- [ ] `npm run test:coverage` locally; global coverage stays at or above **97%** for lines, statements, functions, and branches (aim for **98%+** branch coverage locally so CI variance does not fail near the threshold)
- [ ] `npm run test:workers`
- [ ] `npm run build:mcp`
- [ ] `npm run test:mcp-pack`
- [ ] `npm run ui:openapi:check`
- [ ] `npm run ui:lint`
- [ ] `npm run ui:typecheck`
- [ ] `npm run ui:build`
- [ ] `npm audit --audit-level=moderate`
- [ ] New or changed behavior has unit/integration tests for new branches, fallback paths, and sanitizer boundaries

If any required check was skipped, explain why:

-

## Safety

- [ ] No secrets, wallet details, hotkeys, coldkeys, user PATs, private keys, raw trust scores, private rankings, or private maintainer evidence are exposed.
- [ ] Public GitHub text stays sanitized, low-noise, and does not imply compensation guarantees or optimization tactics.
- [ ] Auth, cookie, CORS, GitHub App, Cloudflare, or session changes include negative-path tests.
- [ ] API/OpenAPI/MCP behavior is updated and tested where needed.
- [ ] UI changes use live API data or real empty/error/loading states, not production mock/demo fallbacks.
- [ ] Visible UI changes include screenshots or a short recording.
- [ ] Public docs/changelogs are updated where needed; changelogs are only edited for release-prep PRs.

## Notes

-
