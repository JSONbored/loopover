# gittensory — AI contributor guide

Loaded automatically by AI coding tools: **Codex** reads this `AGENTS.md`; **Claude Code** reads
`CLAUDE.md` (a symlink to this file) and additionally auto-loads the on-demand skill at
`.claude/skills/contributing-to-gittensory/`.

**Before writing ANY code contribution or pull request to this repo, read and follow the skill:**

- `.claude/skills/contributing-to-gittensory/SKILL.md` — the one-shot-PR playbook (phases + checklist)
- `.claude/skills/contributing-to-gittensory/reference.md` — exhaustive tables (CI, Codecov, the gate, tests, style)

That skill is the **single source of truth** for how to contribute here. Keep it updated as the
process evolves — edits to those files improve both Claude Code and Codex.

## The five things you must not get wrong

1. **The gate auto-merges and auto-closes — it is not advisory.** A *contributor* PR with red CI
   (including `codecov/patch`), a gate failure, a base conflict, or an ineligible linked issue is
   **auto-CLOSED, one-shot** (recovery = open a fresh PR). Green CI + passing gate + mergeable-clean +
   a valid linked issue is **auto-MERGED**. So make it perfect before you push.
2. **97% patch coverage, branch-counted.** Aim for **100% of every changed line *and branch*** — test
   both sides of every `??` / ternary / `&&` (a `SUM()` can return `NULL`, so the nullish arm is real),
   plus invariant tests and a regression test for every fix. Only `src/**` is measured by Codecov.
3. **The whole local gate must be green:** `npm run test:ci` (+ `npm audit --audit-level=moderate`).
   Measure coverage **unsharded** with `npm run test:coverage` (CI shards + merges, so a single shard
   under-reports).
4. **Regenerate and commit generated artifacts:** `npm run ui:openapi` (API/schema changes),
   `npm run cf-typegen` (wrangler binding/var changes), and a contiguous `migrations/NNNN_*.sql`
   (DB changes). Stale generated files fail CI.
5. **House rules:** Conventional Commits, **no AI/Claude/agent attribution** in commits or PR text;
   no secrets / wallets / hotkeys / trust scores / reward values anywhere; stay inside `wantedPaths`
   and out of `site/`, `CNAME`, `**/lovable/**`; never edit `CHANGELOG.md` in a normal PR.

The full procedure, the gate disposition matrix, test patterns, the MCP pre-submit predictors
(`@jsonbored/gittensory-mcp`), and the PR template are all in the skill files above — use them.
