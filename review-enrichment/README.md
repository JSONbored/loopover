# Review-enrichment service (REES)

A standalone microservice that produces a structured **review brief** for the loopover review engine. Run it
in-network alongside a self-hosted engine via the repo-root `docker-compose --profile rees` service (the simplest
path, no separate hosting to manage — see the [self-hosting REES docs](https://loopover.ai/docs/self-hosting-rees)),
or deploy it as its own service on any platform that can run a Dockerfile-based Node service — see
[Deploy standalone](#deploy-standalone) below.

The engine reviews PRs by running a headless `claude --print` subprocess with `Bash`/`WebFetch` disallowed and **no
repo checkout**, so it cannot run a linter, hit a CVE database, resolve a dependency tree, or query git history. REES
fills exactly that gap: given a PR it runs heavy/external/historical analysis and returns a pre-rendered, public-safe
brief the engine splices into the prompt next to grounding + RAG. It is strictly **additive and fail-safe** — the engine
treats any timeout/error as "no brief" and proceeds.

## API

| Route             | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `GET /health`     | Liveness health check.                                                          |
| `GET /ready`      | Readiness.                                                                      |
| `POST /v1/ping`   | Auth check only — the engine calls this at startup to verify the shared secret matches. Returns `{ok:true}` or 401. |
| `POST /v1/enrich` | `Authorization: Bearer <REES_SHARED_SECRET>` → `EnrichRequest` → `ReviewBrief`. |

> **Secret format:** `REES_SHARED_SECRET` must be set to the **same bare string** on both the engine and the REES
> service — no surrounding quotes, no extra whitespace. Both sides strip surrounding quotes and whitespace
> automatically, but the underlying values must match exactly. If the engine logs `rees_secret_mismatch` or
> `rees_secret_normalized` at startup, check that both env vars are set to the same literal string.

See `src/types.ts` for the `EnrichRequest` / `ReviewBrief` contract. When the engine is configured with
`REES_FORWARD_GITHUB_TOKEN=true`, requests can include a GitHub read token so token-aware analyzers can read
CODEOWNERS and blob sizes. Token forwarding is off by default and should be enabled only when the REES endpoint is
inside the operator's trust boundary. The engine prefers a short-lived installation token and falls back to
`GITHUB_PUBLIC_TOKEN`. The service must never log request bodies, diffs, or tokens.

## Analyzers

| Analyzer | Purpose | Network/token behavior |
| --- | --- | --- |
| `dependency` | Direct dependency CVEs from changed manifests. | Calls OSV.dev. |
| `dependencyDiff` | Summarizes direct dependency add/remove/version-change deltas in changed manifest patches — informational, not a CVE scan. | Pure local. |
| `lockfileDrift` | Vulnerable transitive versions introduced only through lockfiles. | Calls OSV.dev querybatch. |
| `secret` | Credential-shaped values in added diff lines. Values are never returned. | Pure local. |
| `license` | Copyleft or unknown dependency licenses. | Calls deps.dev. |
| `installScript` | npm packages that run install lifecycle hooks. | Calls the npm registry. |
| `heavyDependency` | Flags materially heavy npm dependencies used only a few times in changed lines. | Calls a public registry/advisory API. |
| `hardcodedUrl` | Flags absolute HTTP(S) URLs and raw IP:port endpoints newly added in non-test, non-config source. | Pure local. |
| `actionPin` | Third-party GitHub Actions pinned to mutable refs. | Pure local. |
| `eol` | Runtime/base-image pins that are EOL or close to EOL. | Calls endoflife.date. |
| `redos` | Regex literals with catastrophic-backtracking structure. | Pure local. |
| `provenance` | Missing package attestations plus binary/vendored/minified additions. | Calls npm/PyPI for attestations; path checks are local. |
| `codeowners` | Changed files owned by CODEOWNERS entries that do not include the PR author. | Calls GitHub API; needs author and token for private repos. |
| `secretLog` | Secrets, PII, or request/session objects written to logs/stdout. | Pure local. |
| `assetWeight` | Heavy binary assets added or grown. | Calls GitHub API; needs headSha, baseSha for growth, and token for private repos. |
| `typosquat` | New dependency names that look squatted or publicly claimable. | Uses bundled popular-package lists plus npm/PyPI lookups. |
| `commitSignature` | Head commit signature/author provenance worth checking. | Calls GitHub API; needs headSha and token for private repos. |
| `iacMisconfig` | Risky IaC/config changes like public buckets, open ingress, or insecure CORS. | Pure local. |
| `nativeBuild` | Newly-added dependencies that compile native code or ship sdist-only builds. | Calls npm/PyPI registries. |
| `history` | Author track record, same-file PR history, and linked-issue alignment. | Calls GitHub API with bounded fanout; needs author/token for private repos. |
| `docCommentDrift` | Flags a JSDoc/TSDoc @param that names a parameter the PR removed or renamed but left documented. | Calls GitHub API; needs headSha and a token for private repos. |
| `duplication` | Flags added code that is a near-verbatim duplicate of a block already present elsewhere in the repo. | Calls GitHub API; needs headSha and a token for private repos. |
| `duplicationDelta` | Flags a duplicate block pair that existed in a changed file's pre-PR content and is no longer both present — a consolidation the no-checkout reviewer cannot see. | Calls GitHub API; needs headSha and a token for private repos. |
| `churnHotspot` | Flags changed files that are statistical fragility hotspots — high commit frequency and a high fix/revert fraction. | Calls GitHub API with bounded fanout; needs a token for private repos. |
| `blameLink` | For files this PR modifies or deletes, surfaces the last PR to touch each file — file-level history context, not per-line blame. | Calls GitHub API; needs a token for private repos. |
| `approvalIntegrity` | Flags review/approval integrity signals: an APPROVED review that predates the current head commit, the author approving their own PR, and a reviewer whose current review is still CHANGES_REQUESTED. | Calls GitHub API; needs headSha and a token for private repos. |
| `ciCheckSignals` | Flags a named check that only went green after one or more earlier non-success attempts at the current head commit, and any completed check run whose duration crossed a fixed threshold. | Calls GitHub API; needs headSha and a token for private repos. |
| `undocumentedExport` | Flags exports newly added to a package's public entrypoint (an index.* barrel) that ship with no adjacent doc comment. | Calls GitHub API; needs headSha and a token for private repos. |
| `staleBranch` | Flags a PR whose head is significantly behind the repo's current default branch — a staleness risk a clean `mergeable` check alone would not surface. | Calls GitHub API; needs headSha and a token for private repos. |
| `commitHygiene` | Flags commit-history hygiene issues: a merge commit pulled into the PR's own history, a commit left with git's fixup!/squash! autosquash marker, and a commit carrying a Co-authored-by trailer. | Calls GitHub API; needs a token for private repos. |
| `pendingReviewRequests` | Flags a reviewer or team whose review request has been outstanding 48+ hours with no response yet. | Calls GitHub API; needs a token for private repos. |
| `testRatio` | Flags a PR whose source change is material but ships with disproportionately little (or zero) accompanying test change. | Pure local. |
| `migrationSafety` | Flags risky schema operations in added migration SQL: drops, renames, non-nullable columns without a default, and blocking table rewrites. | Pure local. |
| `looseRange` | Flags newly-added npm dependency specifiers that use dangerously loose ranges instead of a pinned/caret/tilde range. | Pure local. |
| `terminology` | Flags non-inclusive terms newly added in identifiers or comments (whitelist/blacklist, master/slave) and suggests the neutral replacement. | Pure local. |
| `todoMarker` | Surfaces TODO/FIXME/HACK/XXX markers a PR adds in comments, so a reviewer sees the change is shipping known-incomplete work. | Pure local. |
| `magicNumber` | Non-trivial numeric literals newly added in non-test source. | Pure local. |
| `conflictMarker` | Flags leftover VCS conflict markers (`<<<<<<<`, `\|\|\|\|\|\|\|`, `=======`, `>>>>>>>`) accidentally committed in added lines. | Pure local. |
| `debugLeftover` | Flags debugging leftovers a PR adds in non-test source — `debugger;`, bare console sinks, or `print()` calls. | Pure local. |
| `sizeSmell` | Flags maintainability size smells from patch structure: an estimated resulting file length or an added function body span that exceeds configured thresholds. | Pure local. |
| `floatingPromise` | Flags newly-added promise-shaped calls whose returned promise is neither awaited, returned, voided, nor same-line .then/.catch-chained. | Pure local. |
| `deepNesting` | Flags newly-added control-flow blocks whose nesting depth exceeds a threshold inside a contiguous run of added lines. | Pure local. |
| `errorSwallow` | Flags newly-added catch/except blocks (and Go if-err checks) that swallow or mishandle the error — empty body, unused binding, a bare `return null`/`nil`, or a Python bare `except:` naming no exception type. | Pure local. |
| `complexity` | Flags a newly-added function whose approximate cyclomatic complexity (branch/loop/logical-operator density, computed on the diff-visible lines) exceeds a threshold. | Pure local. |
| `complexityDelta` | Flags a function whose approximate cyclomatic complexity changed between the pre-PR and head versions of a file -- not just newly-added functions. | Calls GitHub API; needs headSha and a token for private repos. |
| `unsafeAny` | Counts and locates explicit `any` annotations, `<any>` assertions, and `as any` casts newly introduced in TypeScript diffs. | Pure local. |
| `a11y` | Flags common accessibility regressions in newly added JSX/HTML markup lines. | Pure local. |
| `i18n` | When the diff shows a translation convention, flags newly-added user-facing JSX text or label/title props that bypass it. | Pure local. |
| `unusedExport` | Flags exports newly added by the PR that have zero non-declaration references anywhere in the repo. | Calls GitHub API; needs headSha and a token for private repos. |
| `exhaustiveness` | Flags when a PR adds a new enum member or string-literal union variant but an exhaustive switch still omits it. | Calls GitHub API; needs headSha and a token for private repos. |
| `flakyTest` | For test files this PR touches, surfaces recent default-branch CI test-check failures that reference each file. | Calls GitHub API with bounded fanout; needs a token for private repos. |
| `commitLint` | Lints the PR's commit subjects against the Conventional Commits spec and flags non-conforming subjects (bad/absent type, over-long, or empty). | Calls GitHub API; needs a token for private repos. |
| `apiBreak` | Flags an exported symbol a PR removes or renames in a package public entrypoint — a semver-major break for downstream consumers shipped without a major version bump. | Pure local. |
| `deprecatedDep` | Flags a direct dependency a PR newly adds or upgrades that is an officially deprecated or unmaintained package with a maintained successor — an adoption risk the review brief should surface. | Pure local. |
| `revertRecurrence` | Flags a changed file where the PR re-introduces added lines in a region a prior revert commit removed — a signal it may be re-treading a path that was already reverted or hot-fixed out. | Calls GitHub API with bounded fanout; needs a token for private repos. |
| `coverageDelta` | Flags added lines in a PR that the project's own latest successful CI coverage report records as never executed — measured test gaps on exactly the touched lines, not a guess about whether tests look present. | Calls GitHub API with bounded fanout; needs headSha and a token for private repos. |
| `callerImpact` | Flags an exported symbol the PR removes or renames away from an internal source file that unchanged in-repo files still import — a hidden cross-file compile/runtime break the diff-only reviewer cannot see. | Calls GitHub API with bounded fanout; needs headSha and a token for private repos. |

The engine can send `analyzers: ["secret", "actionPin"]` to run a subset. If the field is omitted, REES runs the
full registry. An explicit empty array runs no analyzers; the engine uses that fail-closed shape when an
operator-configured analyzer list contains no valid names.

## Analyzer manifests

Analyzer runtime metadata lives in `src/analyzers/registry.ts` as `AnalyzerDescriptor` entries. New analyzer work
should prefer the modular shape introduced for `dependency` and `secret`:

| File                                      | Purpose                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| `src/analyzers/<name>/descriptor.ts`      | Analyzer name, title, category, cost, requirements, docs, run function, and optional renderer. |
| `src/analyzers/<name>.ts`                 | Pure scanner helpers and the analyzer implementation.          |
| `test/<name>.test.ts`                     | Focused tests for scanner behavior, rendering, and degradation. |

Descriptors are the extension point future REES runtime work will use for profiles, docs generation, scheduler cost
classes, per-analyzer limits, and self-host configuration. When adding or migrating an analyzer:

- Keep the public analyzer name stable; it is what `REES_ANALYZERS` and the engine request body use.
- Put operator-facing metadata in the descriptor: `category`, `cost`, `defaultEnabled`, `requires`, `limits`, and
  `docs`.
- Keep renderer output public-safe. Never include tokens, request bodies, diffs, raw prompts, comments, or private
  config values.
- Make external-call analyzers fail open and respect the orchestrator abort signal when the scanner supports it.
- Prefer a focused analyzer test file instead of expanding the shared `enrichment.test.ts` mega-test.

### Magic-number analyzer

`magicNumber` is a precision-first local analyzer for unexplained numeric literals added by a PR. It is intended to
surface values that look like policy, timing, sizing, retry, threshold, or scoring decisions hidden directly inside an
expression, where a named constant would make intent and future review safer.

The analyzer scans only added diff lines in non-test source files. It never fetches repository content, never
evaluates code, and never returns source snippets. Findings carry only `{ file, line, value }`, so the review brief can
say that `src/retry.ts:42` added `37` without copying the surrounding line.

What it reports:

- Numeric literals in expressions, such as `attempt * 37`, `timeout + 250`, `ratio > 0.73`, or `0xff` masks.
- Signed and fractional forms when they are part of the literal, such as `-42`, `.75`, `6e-3`, or `99n`.
- Multiple reportable values on one added line, capped by the analyzer-level finding limit.
- Added content whose source text begins with plus signs, matching the unified-diff edge cases covered by sibling
  analyzers.

What it suppresses:

- Test files and snapshot paths, because assertion literals are usually expected examples rather than production
  policy.
- Documentation, JSON/YAML, lockfiles, fixtures, and other non-source files.
- String literals and inline comments before numeric scanning, so prose like `"wait 37 seconds"` or `// retry in 42`
  does not generate a finding.
- Common sentinel and scale values: `0`, `1`, `-1`, `2`, `100`, `1000`, and powers of ten.
- Named constant declarations, including common language forms such as `const MAX_BATCH = 250`, `static readonly
  RETRY_WINDOW = 30`, `public static final int LIMIT = 50`, `final DEFAULT_LIMIT = 50`, and `val MAX_PAGE_SIZE = 250`.
- Array indexes like `rows[3]`, numeric object keys like `{ 404: handler }`, and enum-like member initializers like
  `PENDING = 3`.

The goal is not to ban numeric literals. It is to highlight newly-added non-obvious values that can silently encode
review-critical behavior. The analyzer favors false negatives over noisy findings: if a literal looks named,
structural, test-only, or conventional, it stays silent.

Example outcomes:

| Added source line | Analyzer result | Rationale |
| ----------------- | --------------- | --------- |
| `const timeoutMs = attempts * 37;` | Reports `37`. | The value is embedded in behavior and is not self-describing. |
| `const RETRY_WINDOW_MS = 37;` | Suppressed. | The uppercase declaration gives the literal a reviewable name. |
| `if (ratio > 0.73) return true;` | Reports `0.73`. | Fractional thresholds are usually policy choices. |
| `return rows[3];` | Suppressed. | Small positional array indexes are structural. |
| `return items[:37];` | Reports `37`. | Slice bounds can encode a batch or display limit. |
| `{ 404: handleMissing }` | Suppressed. | Numeric object keys are commonly protocol or lookup labels. |
| `enum State { Pending = 3 }` | Suppressed. | Enum-like member initializers are named states. |
| `const mask = flags & 0xff;` | Reports `0xff`. | Radix literals can hide bitmask decisions. |
| `const sample = 1_337;` | Reports `1_337`. | Numeric separators keep the original literal readable in findings. |
| `const scale = 1000;` | Suppressed. | Powers and common scales are intentionally quiet. |

Operational notes:

- Keep findings public-safe: report the file, line, and literal only, never the surrounding source text.
- Use the diff hunk line number, not a best-effort grep against the repository checkout.
- Scan added lines only. Removed or context lines should never create findings.
- Apply the source-path filter before scanning content so generated metadata and docs stay quiet.
- Respect the abort signal both before and during patch scanning.
- Keep line-level work bounded; very long added lines are skipped to avoid pathological input.
- Preserve deterministic ordering by scanning files, hunks, and literals in diff order.
- Cap per-line and per-request findings so one generated file cannot dominate the brief.
- Add tests for both the reported and suppressed side of every new heuristic.
- Regenerate analyzer metadata whenever the registry descriptor changes.

## Shared analysis context

Each `/v1/enrich` request now gets a request-scoped `AnalysisContext` before analyzers run. New and migrated
analyzers should prefer it for shared PR facts instead of reparsing the envelope:

| Context surface | Purpose |
| --------------- | ------- |
| `changedFiles` / `changedFilePaths` | The request's changed file list and paths. |
| `addedLines` | Unified-diff added lines with file and new-line number tracking. |
| `patchHunks` | Parsed hunk locations for analyzers that need bounded line-aware scans. |
| `fileCategories` | Coarse public-safe file categories used for fast filtering. |
| `dependencyChanges()` / `packageChanges()` | Cached direct package changes from changed manifests. |
| `cachedExternalCall(category, key, load)` | Request-scoped in-flight de-duplication for identical external lookups. |

Context caches are request-scoped only. They are for avoiding duplicate work inside one enrichment run, not for
cross-request TTL storage. Cache metrics are aggregate and public-safe: hit/miss counts, external-call counts by
category, skipped/capped work counts by category, and elapsed time. Never put request bodies, diffs, prompts,
comments, tokens, private configs, or raw external payloads into cache categories, metric keys, PostHog tags, or logs.

The engine also sends `budget.timeoutMs` with one second of headroom below `REES_TIMEOUT_MS`, so REES can return a
partial/degraded brief before the caller aborts the HTTP request. If your REES deployment is still running an older
build, temporarily raise the engine-side `REES_TIMEOUT_MS` above the REES analyzer budget, or set `REES_ANALYZERS` to
a bounded list that excludes `history` until the budget-aware build is deployed.

## Run locally

```sh
npm install
REES_SHARED_SECRET=dev npm run build && npm start   # listens on :8080
curl localhost:8080/health
curl -XPOST localhost:8080/v1/enrich -H 'authorization: Bearer dev' \
  -H 'content-type: application/json' -d '{"repoFullName":"o/r","prNumber":1}'
```

## Deploy standalone

For a self-hosted engine, `docker compose --profile rees up -d` from the repo root (see the
[self-hosting REES docs](https://loopover.ai/docs/self-hosting-rees)) is the simplest path — no
separate service to host. If you'd rather run REES on its own outside that compose network, it's a plain
Dockerfile-based Node service and can go anywhere that builds one — point your platform's Dockerfile builder at
this directory (**Root Directory = `review-enrichment`**) and set `REES_SHARED_SECRET` (same value the engine
holds) as a runtime env var — never commit it. Reach the service however your platform does private
networking, or over a public domain with the shared secret as the only gate.

## PostHog releases and source maps

REES supports optional PostHog error reporting and source-map upload for standalone deployments. The Docker
image builds `dist/*.js.map` with embedded `sourcesContent`, then the runtime startup command injects PostHog
chunk ids, uploads the exact post-injection `dist/` files, removes source maps from the running filesystem, and
starts `dist/server.js`.

Set these runtime env vars:

| Variable                        | Purpose                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `POSTHOG_API_KEY`                | Enables REES error capture (a PostHog project token). Unset means a no-op.  |
| `POSTHOG_HOST`                   | Optional PostHog ingestion host override (EU region).                       |
| `POSTHOG_ENVIRONMENT`            | Optional; defaults to `production`.                                         |
| `POSTHOG_RELEASE`                | Optional override. Only set it when that exact REES bundle is uploaded.     |
| `POSTHOG_COMMIT_SHA`             | Optional; used to derive `POSTHOG_RELEASE` (`loopover-rees@<sha>`) when unset. |
| `POSTHOG_CLI_API_KEY`            | A PostHog **personal** API key (error-tracking write + organization read scopes) -- allows the runtime uploader to upload source maps. Distinct from `POSTHOG_API_KEY`. |
| `POSTHOG_CLI_PROJECT_ID`         | The PostHog project's numeric id, required alongside `POSTHOG_CLI_API_KEY`. |
| `POSTHOG_CLI_HOST`               | Optional posthog-cli host override (EU region).                             |
| `REES_POSTHOG_UPLOAD_STRICT`     | Optional. Set `true` to fail startup if source-map upload fails.            |
| `REES_POSTHOG_VALIDATE_RELEASE`  | Optional. Set `false` only to disable post-upload release validation.       |

Do **not** pass `POSTHOG_CLI_API_KEY` as a Docker build arg on any platform that deploys this service from Git --
build args can leak through image metadata. Keeping the upload at runtime means PostHog sees the same `dist/`
files that the service executes, without exposing source maps over HTTP.

After upload, startup validates the release by querying PostHog's `error_tracking/symbol_sets` API: at least one
symbol set must exist for the release, with no recorded `failure_reason`. PostHog's release model has no
Sentry-style commits/deploys/finalize lifecycle to check beyond that. If `REES_POSTHOG_UPLOAD_STRICT=true`, a
failed upload or failed validation stops startup; otherwise it logs a `rees_posthog_sourcemap_upload_failed`
warning so the problem is visible without blocking startup.

Analyzer failures are still fail-open: the `/v1/enrich` response marks the analyzer as `degraded` and returns a
partial brief. When PostHog is enabled, those degradations are captured as `rees_analyzer_degraded` events with
properties for `analyzer`, requested analyzer list, `repo`, `pullNumber`, head SHA prefix, `release`,
`environment`, timeout budget, elapsed time, partial/analyzer status, history lookup counts, GitHub endpoint
category, request id, and trace id. Use those fields to spot a broken analyzer without exposing request bodies,
diffs, tokens, prompts, comments, or private config.

### REES PostHog queries

REES keeps its indexed PostHog properties intentionally small and stable:

- `event`
- `route`
- `method`
- `repo`
- `pullNumber`
- `analyzer`
- `release`
- `environment`
- `deploymentId`

Useful production queries:

- Route exceptions on the enrichment endpoint:
  - `event:rees_route_error route:/v1/enrich method:POST`
- Analyzer failures grouped by analyzer:
  - `event:rees_analyzer_degraded analyzer:history`
  - `event:rees_analyzer_degraded analyzer:dependency repo:JSONbored/loopover`
- Source-map upload/startup failures:
  - `event:rees_sourcemap_upload_failed`
- Process-level crashes:
  - `event:rees_uncaught_exception`
  - `event:rees_unhandled_rejection`

If PostHog still shows frames such as `/app/dist/server.js`, check:

1. The event's `release` is `loopover-rees@<same commit sha>` or your exact `POSTHOG_RELEASE` override.
2. The PostHog project has a symbol set uploaded for that release.
3. The deployment has `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID` set.
4. Startup logs include `rees_posthog_release_validation_complete` for the same release id.
5. `npm --prefix review-enrichment run validate:sourcemaps` passes locally.
