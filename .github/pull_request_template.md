## Summary

-

## Validation

- [ ] `npm run test:ci`
- [ ] `npm run test:coverage` locally; global coverage stays at or above **95%** for lines, statements, functions, and branches (aim for **96%+** branch coverage locally so CI variance does not fail near the threshold)
- [ ] New or changed behavior has unit/integration tests for new branches, fallback paths, and sanitizer boundaries
- [ ] Changelog updated only if this is a release-prep change

## Safety

- [ ] Backend-only change
- [ ] No secrets, wallet details, user PATs, raw trust scores, or private rankings exposed
- [ ] Public text avoids compensation-seeking or optimization-tactic language
- [ ] OpenAPI/MCP behavior updated where needed
- [ ] Public docs/changelogs updated where needed
