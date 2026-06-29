# gittensory contribution — deep reference

Exhaustive tables and patterns behind the `SKILL.md` playbook. Read the section you need; you don't
need all of it for every change. All commands run from the repo root unless noted.

**Bootstrap (fresh clone):** external contributors **fork** `JSONbored/gittensory`, then
`git clone` their fork, `nvm use` (Node 22 via `.nvmrc`), and **`npm ci`** (required before any check
runs). Add the upstream remote — `git remote add upstream https://github.com/JSONbored/gittensory` —
and `git fetch upstream && git rebase upstream/main` before pushing if `main` moved (a base conflict
auto-closes a contributor PR). Push to your fork; open the PR from it. A first fork PR's Actions wait
for maintainer approval (CI shows unverified → the engine **holds**, never closes — this is expected).

---

## 1. Every CI check → local command → what fails it

The single **required** status check is **`validate`** (it aggregates `changes, lint, test, workers,
mcp, ui, security`; a path-skipped job counts as success). **Codecov** posts `codecov/patch` (the real
coverage gate) and `codecov/project` (informational) independently. The review engine also posts its
own check run named **`Gittensory Orb Review Agent`** (`src/github/app.ts` `GITTENSORY_GATE_CHECK_NAME`) — the gate
verdict (§3), separate from CI. On a PR, jobs run only if their
path filter matched; on push to `main`, everything runs.

| Check | Runs | Local command | Fails when |
|---|---|---|---|
| changes | `git diff --check` + path filter | `git diff --check` | trailing whitespace / conflict markers |
| lint → actionlint | workflow lint | `npm run actionlint` | any `.github/workflows/*.yml` violation |
| lint → migrations | migration guard | `npm run db:migrations:check` | duplicate/gap/misnamed migration number |
| lint → typecheck | `tsc --noEmit` | `npm run typecheck` | any backend type error |
| test (1/2) | sharded vitest + coverage | `npm run test:coverage` (unsharded) | any failing `test/**/*.test.ts` (excl. `test/workers/**`) |
| workers | workers-pool vitest | `npm run test:workers` | any failing `test/workers/**` |
| mcp → build | MCP pkg build | `npm run build:mcp` | MCP package build error |
| mcp → pack | tarball hygiene | `npm run test:mcp-pack` | unexpected/forbidden file or stale README in the npm tarball |
| ui → openapi drift | spec check | `npm run ui:openapi:check` | committed `openapi.json` is stale (run `npm run ui:openapi`) |
| ui → version audit | MCP version copy | `npm run ui:version-audit` | stale MCP version strings / non-`@latest` install copy (hits npm registry) |
| ui → lint | `eslint .` (UI) | `npm run ui:lint` | ESLint **incl. Prettier formatting** + design-token rules |
| ui → typecheck | `tsc --noEmit` (UI) | `npm run ui:typecheck` | UI type error |
| ui → tests | vitest jsdom (UI) | `npm run ui:test` | failing UI component test |
| ui → build | UI build | `npm run ui:build` | build failure (note: it re-runs `ui:openapi` internally) |
| security (PR only) | dependency-review (moderate+) | `npm audit --audit-level=moderate` | a **newly added** dep has a moderate+ advisory |

**One command for everything except `security`:** `npm run test:ci`. There is **no** CodeQL/Analyze
workflow in this repo. There is **no** root-level Prettier gate — Prettier is enforced only inside
`ui:lint` (so it only bites `apps/gittensory-ui/**`).

---

## 2. Codecov — the real coverage gate (`codecov.yml`)

- **`codecov/patch`: `target: 97%`, `threshold: 0%`, `if_ci_failed: error`.** Every line your PR
  changes must be ≥97% covered. With 0% threshold and small diffs, **one uncovered branch can fail it.**
- **It counts BRANCH coverage** (v8 → lcov `BRDA`). A changed line whose branches are only partially
  exercised counts against you. "100% lines" ≠ "100% branches."
- **`codecov/project`: `informational: true`** — a trend, never blocks.
- **Ignored paths** (no coverage obligation): `apps/**`, `test/**`, `scripts/**`, `src/env.d.ts`.
  Coverage `include` is `src/**/*.ts` only. → A UI-only / test-only / script-only change owes **no**
  patch coverage; a backend `src/**` change owes coverage on **every changed line + branch**.
- **Measure unsharded locally:** `npm run test:coverage`. CI shards into 2 and Codecov merges them,
  so a single local shard under-reports — never trust it.

---

## 3. The gittensory gate — it auto-MERGES and auto-CLOSES (not advisory)

The engine reviews every PR and **acts on it** with autonomy (`src/settings/agent-actions.ts`
`planAgentMaintenanceActions`). A scheduled sweep re-evaluates open PRs roughly every ~2 minutes, so a
disposition lands quickly once checks settle. For a **contributor** PR (not the repo owner, not an
automation bot), the disposition is one-shot:

| Condition | Disposition |
|---|---|
| gate `success` **and** CI `passed` (all checks, **codecov/patch included**) **and** mergeable `clean` **and** approvals satisfied **and** no guardrail hit | **auto-approve → MERGE** |
| CI `failed` (any check) | **CLOSE** (cites the failing check) |
| gate `failure` | **CLOSE** |
| base `dirty` (merge conflict) | **CLOSE** |
| linked-issue **hard-rule** violation (issue owner-assigned / maintainer-only / missing point label) | **CLOSE** (deterministic — fires even on a guarded path; optional flag-then-close two-pass) |
| CI `pending` | **no action** — waits for the check-completion webhook |
| CI `unverified` (fork Actions awaiting approval, unreadable checks) | **HELD** for review (never closed — fork false-close guard) |
| changed path hits a **hard guardrail** (CI configs, the review engine, visual capture) | **HELD** for the owner — every would-merge/approve/close becomes a manual hold |
| gate `neutral` (advisory-only on a non-confirmed contributor, or eval-not-ready) | **HELD** + labeled (not merged, not closed) |
| gate `skipped` (genuinely not evaluated) | no action |

Implications for you:
- **Red CI = your PR is closed.** Not held, not commented — closed. `codecov/patch` is a CI check, so
  a coverage miss closes the PR. This is why Phases 3–5 are non-negotiable.
- **A merge conflict closes the PR** — keep your branch current with `main`.
- **Linking the wrong issue closes the PR** — only link an open, unassigned, eligible issue (verify
  with `gittensory_validate_linked_issue`).
- Owner / automation-bot PRs are exempt from auto-close, and crucial guarded-path PRs are held — but
  **assume you are a contributor** and that adverse = close.

`.gittensory.yml` (the public config you can predict against) sets the gate *modes* (`linkedIssue:
advisory`, `duplicates: block`, `readiness: advisory/60`, AI review off) and the focus manifest
(`wantedPaths`: `src/ packages/ test/ migrations/ scripts/ review-enrichment/ .github/workflows/
wrangler.jsonc apps/gittensory-ui/`; `blockedPaths`: `site/ CNAME **/lovable/**`; `linkedIssuePolicy: preferred`;
`testExpectations: npm run test:ci`). But the **modes are inputs to the disposition above** — the
engine still auto-merges the clean case and auto-closes the adverse case. The MCP `predict_gate` uses
the public config + safe defaults; a clean prediction is necessary but not sufficient (it can't see
private overrides or AI-consensus), so the change must also be genuinely correct and fully green.

---

## 4. Slop signals — keep risk LOW (`src/signals/slop.ts`)

PR-side signals that raise slop risk (band: clean 0 / low 1–24 / elevated 25–59 / high 60+):

- **Trivial whitespace churn** (≥40 changed lines but <15% real source) → keep diffs source-dense;
  split lockfile/docs/formatting-only changes out.
- **Missing test evidence** (code changed, no test files / no test mention) → add `*.test.ts` or note
  tests in the commit/body.
- **Non-substantive padding** (majority generated/vendored/minified) → exclude generated output.
- **Empty description** (code changed, blank body) → always fill the PR body.

---

## 5. MCP pre-submit tools (`@jsonbored/gittensory-mcp`)

Install + configure (let the CLI print the right config for your tool — **Codex is TOML, not JSON**):

```sh
npm install -g @jsonbored/gittensory-mcp@latest
gittensory-mcp login                        # GitHub device flow
gittensory-mcp init-client --print codex    # → ~/.codex/config.toml  ([mcp_servers.gittensory])
gittensory-mcp init-client --print claude   # or --print cursor  (→ mcpServers JSON)
```

All tools are metadata-only (no source upload). Run in this order:

1. `gittensory_check_before_start` — `{owner, repo, issueNumber, plannedChange{title, paths}}` →
   go/raise/avoid (claimed? duplicate cluster? already solved?).
2. `gittensory_validate_linked_issue` — `{owner, repo, issueNumber, plannedChange}` → is the issue
   open, valid, single-owner, solvable by this PR.
3. `gittensory_check_slop_risk` — `{changedFiles[{path,additions,deletions}], description, tests,
   testFiles}` → slopRisk 0–100 + band + findings.
4. `gittensory_lint_pr_text` — `{commitMessages[], prBody, linkedIssue}` → verdict
   strong/adequate/weak + specific fixes.
5. `gittensory_predict_gate` — `{login, owner, repo, title, body, labels, linkedIssues}` → predicted
   conclusion + blockers + warnings + readiness score.

(Auth'd extras: `gittensory_preflight_pr` / `…_local_diff` for lane fit + collision + queue health.)

---

## 6. Tests — helpers, branch coverage, invariants, regressions

**Layout:** `test/unit/` (pure, no I/O) · `test/integration/` (routes + D1) · `test/workers/`
(Cloudflare pool, `vitest.workers.config.ts`) · `test/contract/` · `test/fixtures/` · `test/helpers/`
· `test/stubs/`. Globals are on (no need to import `describe/it/expect`). Test timeout 15s.

**D1 + env:** `test/helpers/d1.ts` exports `TestD1Database` (in-memory `node:sqlite`, applies every
`migrations/*.sql`) and `createTestEnv(overrides?)`. Pattern:

```ts
import { createTestEnv } from "../helpers/d1";
const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" });
await env.DB.prepare(`INSERT INTO repositories (full_name, owner, name) VALUES (?,?,?)`)
  .bind("JSONbored/gittensory", "JSONbored", "gittensory").run();
const row = await env.DB.prepare(`SELECT * FROM repositories WHERE full_name = ?`)
  .bind("JSONbored/gittensory").first<RepoRow>();
```

**Route tests:** `createApp()` from `src/api/routes` + `app.request(path, init, env)`. **Fetch stub:**
`vi.stubGlobal("fetch", async (input, init) => Response.json({...}))`, clean up in
`afterEach(() => vi.unstubAllGlobals())`. **Clock:** `vi.useFakeTimers(); vi.setSystemTime(new
Date("2026-05-28T00:00:00Z"))` then `vi.useRealTimers()`.

**Iterate, then verify.** Scope while writing: `npx vitest run test/unit/<file>.test.ts` (or `-t`),
or the `test:unit` / `test:integration` scripts. Verify before pushing with the full unsharded
`npm run test:coverage`. **Find a partial branch:** read the v8 text report's **% Branch** column and
the **Uncovered Line #s** for your changed file (or open `coverage/lcov-report/…` / `coverage/lcov.info`)
— a line at 100% lines but <100% branch has an un-taken side. Aim ≥98% branch on the diff locally.

**Branch coverage — the rule that fails most PRs.** Each of `if/else`, `? :`, `&&`, `||`, and `??`
is two branches; exercise **both**.

```ts
// SUM(...) over an empty set returns NULL → the `?? 0` nullish arm IS reachable. Test it:
it("coerces a null aggregate to 0", () => {
  expect(rowFromDbWithNullCount.count ?? 0).toBe(0);      // nullish side
});
it("uses the real count when present", () => {
  expect(rowFromDbWithCount.count ?? 0).toBe(7);          // present side
});
// Fail-safe path: make the dependency throw and assert the degraded result.
it("degrades to neutral when the D1 read throws", async () => { /* env.DB.prepare → all() throws */ });
```

**Invariants** (mirror existing suites): for public/private boundaries, state→verdict/tone maps,
sorting, gating — assert the correct output for each state **and** that no competing state leaks
(e.g. a gate `failure` body contains the failure tone and **none** of the other tones; public output
contains **no** wallet/hotkey/trust/reward terms). Seeded loops (LCG) are used instead of external
property libs.

**Regression tests:** every bug fix ships a test named for the bug (e.g. `"… (regression for #1066)"`)
that reproduces the old failure and pins the fix.

**CONTRIBUTING test expectations:** add/refresh tests for new branches, fallback paths, sanitizer
rules; backend routes need success / denied / invalid-input / missing-auth / scoped-auth / rate-limit
/ error-shape cases; auth needs cookie + bearer + logout + OAuth-failure + device-flow; CORS needs
trusted-vs-untrusted; OpenAPI protected/public must match middleware; public comments must assert
absence of forbidden terms.

---

## 7. Style, lint, naming

- **Prettier (UI):** printWidth 100, double quotes, semicolons, `trailingComma: all`. Fix:
  `npm --workspace @jsonbored/gittensory-ui run format`. (`routeTree.gen.ts` and lockfiles are ignored.)
- **ESLint (UI):** `react-hooks/recommended`; `react-refresh/only-export-components` (non-component
  exports must move to a `*-model.ts`); **design-token** `no-restricted-syntax` in
  `src/components/site/**` + `src/routes/**` (use `text-token-*`, `leading-token-*`, `rounded-token`,
  `border-hairline`, `divide-hairline` — not raw `text-sm`/`rounded-md`/`leading-*`/`border-*`);
  **no `server-only`** import.
- **Naming:** `camelCase` vars/functions, `SCREAMING_SNAKE_CASE` env/consts, `PascalCase`
  types/components, `kebab-case.ts` files. Suffixes: `*-model.ts` (pure helpers/types for a
  component), `*-wire.ts` (flag guard + init), `*.test.ts` / `*-route.test.ts`.
- **Comments:** sparse, explain *why*, anchor non-obvious logic to `(#issue)`. Match surrounding density.
- **DB:** core tables → Drizzle (`src/db/schema.ts`, use `$defaultFn(() => nowIso())` for timestamps,
  not a static SQL default); feature/aggregate tables → raw-SQL migrations.

### Config-as-code parity (a new per-repo gate/setting field)
Wire it in **every** site in the **same** PR, or review fails:
1. DB migration (`migrations/NNNN_*.sql`) for the new column/table.
2. Drizzle schema + types (`src/db/schema.ts`, `src/types.ts`).
3. The settings resolver / focus-manifest loader (so `.gittensory.yml` > DB > defaults still holds).
4. OpenAPI (`npm run ui:openapi`) for any new request/response field.
5. The `.gittensory.yml` schema + docs so contributors can set it.
6. Tests covering the new field's resolution precedence + the gate behavior it drives.

---

## 8. Commits & PR text (what `lint_pr_text` scores)

**Commit (Conventional):** `type(scope): summary` — types `feat fix test docs refactor build ci chore
revert`; lowercase specific scope (`api ui mcp review signals stats scoring auth github data draft …`);
no trailing period; ≥15 chars and ≥2 real tokens; not a bare generic word (`update/fix/wip/cleanup/
misc/…`); **no AI/Claude/agent mention**. Changelogs are generated by `git-cliff` at release — **don't
edit `CHANGELOG.md` in a normal PR.**

**PR body verdict** = traceability (30) + commit message (35) + body (35); aim **strong**:
- **Traceability** ok: a linked issue, or an explicit no-issue rationale (`no issue because …`,
  `docs only`, `maintenance`, `typo`, `chore`).
- **Body** ok: real prose (≥40 chars, specific) **and/or** a validation note (mentions
  `test/tested/vitest/npm test/validated/verified/smoke`). Don't leave an unfilled template.
- All evidence is run through the public-comment sanitizer — forbidden terms (`wallet, hotkey,
  coldkey, payout, reward, trust score, scoreability, …`) are dropped; just don't use them.

**The PR body itself** = GitHub pre-fills `.github/pull_request_template.md` (sections `Summary / Scope
/ Validation / Safety / UI Evidence / Notes`, each a checkbox list). Fill it honestly — don't replace
it: write a real Summary, tick only the Validation commands you actually ran, and complete the Safety
boxes (auth/CORS **negative-path tests**, no-secrets) and the **UI Evidence** thumbnail table
(JPG/PNG, never SVG, never committed) for any visible change. That filled template is what scores
`lint_pr_text` *strong*.

---

## 9. What gittensory does NOT accept (from `CONTRIBUTING.md`)

- `site/`, `CNAME`, VitePress/old static-docs surfaces; `**/lovable/**`.
- Broad rewrites / framework swaps / redesigns without a maintainer-approved issue.
- Production mock/fallback data, or UI claims not backed by the live API.
- Public leaderboards, raw wallet/trust/reward/private-ranking exposure.
- Auto-close/auto-merge/rewriting contributor work; labels outside confirmed-miner policy.
- Storing contributor GitHub PATs; non-GitHub identity providers.
- Large dependency upgrades bundled with unrelated changes.
- Changelog edits in ordinary PRs.
- Low-effort/reward-farming/bulk-generated/no-product-impact PRs.

When in doubt: open an issue first, keep the PR narrow, anchor on an existing analogue, and make every
changed line correct *and* tested.
