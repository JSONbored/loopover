# Repo-agnostic capability audit — miner discovery / claim / scoring

Audit of the `packages/gittensory-miner` discovery, claim, and scoring code for hardcoded or
implicitly gittensory-specific assumptions that would need to become per-tenant configuration before
the loop can run against an arbitrary repo. This is the checklist deliverable for **#4780**; the
follow-up **#4784** executes it (turning each open item below into config, gittensory's own values
surviving only as the default). Audit-and-document only — no code changes here.

## Summary

The miner's discovery/claim/scoring code is **already largely repo-agnostic**. Discovery queries are
caller-supplied, label preferences are generic per-tenant config (`.gittensory-miner.yml` uses plain
`bug`/`enhancement`, not `gittensor:*`), ranking/feasibility are delegated to
`@jsonbored/gittensory-engine` with config-overridable inputs, and runtime knobs live in
`.gittensory-ams.yml`. The remaining assumptions fall into three buckets:

1. **GitHub as the only forge** — the fan-out hardcodes GitHub's REST paths, headers, API version, and
   search-qualifier syntax. This is the single largest gap for a non-GitHub tenant.
2. **An existing forge-host override that isn't reachable from the CLI** — `opportunity-fanout` already
   accepts `apiBaseUrl` (GitHub Enterprise), but `discover-cli` never parses or threads it.
3. **Engine-delegated gittensory *defaults*** — label taxonomy and the miner goal spec default to
   gittensory's conventions in `@jsonbored/gittensory-engine`; they are overridable, but the miner uses
   the gittensory defaults out of the box unless a per-tenant config is supplied.

Everything else audited is already parameterized (see the last section) and needs no #4784 work.

## Findings by file / module

### `lib/opportunity-fanout.js` — discovery fan-out (biggest gap)

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 4 | `const defaultApiBaseUrl = "https://api.github.com"` | (6) endpoint | Per-tenant forge base URL (default github.com). Override path exists (see below) but the default is GitHub. |
| 7 | `const githubApiVersion = "2022-11-28"` | (2) forge protocol | Per-forge API version; **no override today**. |
| 69–71 | `accept: "application/vnd.github+json"`, `"x-github-api-version": githubApiVersion` | (2) forge protocol | Per-forge request headers (a forge adapter). |
| 83 | `` `/repos/${owner}/${repo}${suffix}` `` | (5) query construction | Per-forge repo path template. |
| 202 | `` `${trimmed} state:open type:issue` `` (search qualifiers) | (5) query construction | Per-forge search dialect (GitHub search syntax is assumed). |
| 241 | `"/search/issues"` | (5) query construction | Per-forge search endpoint. |
| 70 | `"user-agent": "gittensory-miner"` | (7) branding | Cosmetic; low priority — a configurable UA string. |

Note: the label extractor (`labelNames`, ~168) and issue projection are already generic — they read
whatever label strings the forge returns, with no `gittensor:*` filter. No change needed there.

### `lib/discover-cli.js` — `discover` command wiring

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 289–290 (fanout) vs `runDiscover` | `opportunity-fanout` accepts `options.apiBaseUrl`, but `runDiscover`'s arg parser only handles `--search` / targets / `--json` — it never parses or passes `apiBaseUrl`, so the existing GitHub-Enterprise override is **unreachable from the CLI**. | (6) endpoint | Thread a forge base URL from `.gittensory-miner.yml` / a `--api-base-url` flag into the fan-out call. |
| 102 | `process.env.GITHUB_TOKEN` | (6) auth | Per-forge credential env var (default `GITHUB_TOKEN`). |

### `lib/opportunity-ranker.js` — candidate ranking (delegated)

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 1–5 | imports `DEFAULT_MINER_GOAL_SPEC`, `parseMinerGoalSpecContent`, `rankMetadataOpportunities` from `@jsonbored/gittensory-engine` | (3) scoring rubric | Ranking is engine-delegated and config-driven via `parseMinerGoalSpecContent`, but falls back to `DEFAULT_MINER_GOAL_SPEC` (gittensory's rubric) when no per-tenant goal spec is provided. #4784 should ensure a tenant goal spec is surfaced/required rather than silently defaulting. |

### `lib/feasibility-cli.js` — feasibility verdict (delegated)

| Line | Assumption | Category | Should become |
| --- | --- | --- | --- |
| 4 | delegates to engine `buildFeasibilityVerdict` | (3) scoring rubric | The status vocabularies (`CLAIM_STATUSES`, `DUPLICATE_CLUSTER_RISKS`, `ISSUE_STATUSES`) are generic; the *verdict logic* lives in the engine. No miner-side hardcode, but the engine rubric is a shared dependency to confirm is tenant-neutral. |

### `@jsonbored/gittensory-engine` (shared dependency the miner scores through)

| Location | Assumption | Category | Should become |
| --- | --- | --- | --- |
| `src/settings/pr-type-label.ts:26–28` | `DEFAULT_TYPE_LABELS = { bug: "gittensor:bug", feature: "gittensor:feature", priority: "gittensor:priority" }` | (1) label names | Already overridable per repo (`#label-modularity`), **default gittensory**. The miner inherits these defaults; #4784 should pass the tenant's label names through. |

## Already parameterized — no #4784 change needed

These were checked and are already tenant-agnostic / config-driven; call them out so #4784 doesn't
redo them:

- **Discovery query** — caller-supplied via `discover --search <query>` or explicit `owner/repo`
  targets; no hardcoded gittensory label query (`discover-cli.js`).
- **Label preferences** — `.gittensory-miner.yml` `preferredLabels` / `blockedLabels` are generic
  (`bug`, `enhancement`, `wontfix`, `duplicate`), not `gittensor:*`.
- **Path scope, feasibility gate, self-plagiarism threshold, concurrency** — all per-tenant in
  `.gittensory-miner.yml` (`wantedPaths`, `blockedPaths`, `feasibilityGate`, `selfPlagiarism`,
  `maxConcurrentClaims`).
- **Runtime caps** — `.gittensory-ams.yml` (`submissionMode`, `capLimits`, `convergenceThresholds`,
  `maxIterations`) are generic runtime knobs.
- **Local stores** — `portfolio-queue`, `claim-ledger`, `event-ledger`, etc. are generic SQLite
  bookkeeping with env-configurable DB paths; no gittensory-specific schema.

## Prioritized checklist for #4784

- [x] **High — forge abstraction (`opportunity-fanout.js`):** move the GitHub API version (7),
  headers (69–71), repo path (83), search endpoint (241), and search-qualifier dialect (202) behind a
  per-tenant forge adapter; keep GitHub as the default.
- [x] **High — thread `apiBaseUrl` to the CLI (`discover-cli.js`):** surface the already-supported
  `opportunity-fanout` `apiBaseUrl` override via config / a flag so a non-`api.github.com` host is
  reachable.
- [x] **Medium — credential env var (`discover-cli.js:102`):** make the token env var name
  configurable (default `GITHUB_TOKEN`).
- [x] **Medium — pass tenant label taxonomy + goal spec through (`opportunity-ranker.js`, engine
  `DEFAULT_TYPE_LABELS`):** ensure the miner supplies the tenant's labels / goal spec instead of
  silently falling back to the gittensory defaults.
- [x] **Low — configurable user-agent (`opportunity-fanout.js:70`).**

## Resolution (#4784)

All five checklist items are resolved (or, where noted, explicitly deferred with a reason); gittensory's
own github.com conventions survive only as defaults, and the existing gittensory discovery path is
unchanged (`resolveForgeConfig()` with no overrides is byte-identical to the pre-#4784 hardcoded
behavior).

- **Forge abstraction — resolved.** [`lib/forge-config.js`](../lib/forge-config.js) is the per-tenant
  forge adapter: `DEFAULT_FORGE_CONFIG` holds every github.com value (base URL, API version + version
  header name, `accept` header, user-agent, repo path prefix, search endpoint, search qualifiers,
  token env var) and `resolveForgeConfig(overrides)` fills any missing field from that default.
  `opportunity-fanout.js` now reads these from the resolved forge instead of module constants, so the
  API version, request headers, repo path, search endpoint, and search-qualifier dialect are all
  per-tenant.
- **`apiBaseUrl` reachable from the CLI — resolved.** `discover` accepts `--api-base-url <url>` (and
  `runDiscover({ apiBaseUrl })`), threading the forge host that the fan-out already supported but that
  the CLI never surfaced. A programmatic caller can also pass the rest of the forge knobs via
  `runDiscover({ forge })`.
- **Credential env var — resolved.** `discover --token-env <VAR>` (and `runDiscover({ tokenEnv })`)
  reads a non-`GITHUB_TOKEN` variable, defaulting to `GITHUB_TOKEN`.
- **Tenant goal spec through — resolved.** `runDiscover` forwards `goalSpecsByRepo` /
  `goalSpecContentByRepo` to the ranker and surfaces `usedDefaultGoalSpec` in both the JSON and the
  human-readable summary, so the fall-back to gittensory's built-in rubric is explicit rather than
  silent. The **discovery** label taxonomy is the goal spec's generic `preferredLabels` /
  `blockedLabels` (already per-tenant). The engine's `DEFAULT_TYPE_LABELS` (`gittensor:*`) is a
  **review-stack** default (overridable per repo via the focus manifest) that the miner discovery
  ranker never consults, so it is **deferred**: changing it belongs to the review path, not #4784's
  discovery/claim scope.
- **Configurable user-agent — resolved.** `forge.userAgent` (default `loopover-miner`).
