## Summary

-

## Scope

- [ ] The PR title follows `type(scope): short summary` Conventional Commit format, for example `fix(api): restore profile access checks`.
- [ ] This PR is focused and does not mix unrelated backend, UI, MCP, docs, dependency, and deploy changes.
- [ ] This follows `CONTRIBUTING.md` and does not reintroduce GitHub Pages, VitePress, `site/`, or `CNAME`.
- [ ] I linked an issue, or this is small enough that the summary explains why an issue is not needed.

## Validation

- [ ] `git diff --check`
- [ ] `npm run actionlint`
- [ ] `npm run typecheck`
- [ ] `npm run test:coverage` locally; **`codecov/patch` requires ≥97% coverage of the lines AND branches you changed** (aim for **98%+** on your diff so CI variance does not fail near the threshold). Global coverage is a non-blocking trend with a loose 90% backstop, not the gate.
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
- [ ] Visible UI changes include a `UI Evidence` section below with JPG/JPEG or PNG screenshots arranged as organized, captioned, clickable thumbnails. SVG screenshots are not used as review evidence. Review-only screenshots or recordings are not committed to the repository.
- [ ] Public docs/changelogs are updated where needed; changelogs are only edited for release-prep PRs.

## UI Evidence

Required for visible UI, frontend, docs, or extension changes. Attach GitHub-hosted JPG/JPEG or PNG screenshots here; SVG screenshots are not accepted as review evidence. Use a compact table/grid of clickable thumbnails with a short state/title such as "Loaded state", "Empty state", "Error state", "Mobile layout", or "PR sidebar". Prefer annotated screenshots with a colored box, outline, arrow, or highlighter showing what changed. Recordings can be supplemental, but screenshots are still expected for visual review. Do not commit review-only screenshots, recordings, or `docs/review-evidence/**` files.

| State / title                         | JPG/PNG evidence                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Loaded state                          | `<a href="FULL_URL.png"><img src="FULL_URL.png" alt="Loaded state" width="240"></a>` |
| Empty/error/mobile state, if relevant |                                                                                      |

## Notes

-
