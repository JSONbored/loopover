# Changelog

## [0.7.1](https://github.com/JSONbored/gittensory/compare/mcp-v0.7.0...mcp-v0.7.1) (2026-07-08)


### Fixes

* **release:** sync package-lock.json via script, not release-please extra-files ([#4179](https://github.com/JSONbored/gittensory/issues/4179)) ([b614317](https://github.com/JSONbored/gittensory/commit/b614317e506fab3b30bf7fc366d67e268952ba02))

## Changelog

## mcp-v0.7.0 - 2026-07-08

### Features
- Gittensory_explain_score_breakdown (#649)
- Gittensory_remediation_plan (#650)
- Expose gate.mergeReadiness + gate.firstTimeContributorGrace in .gittensory.yml (#822) (#826)
- Focus-manifest policy as enforceable gate input (#555) (#827)
- Autonomy-levels framework (#773) (#840)
- AutoMaintain config block + dashboard (#774) (#841)
- Kill-switch + dry-run + action audit (#776) (#842)
- Deterministic local scorer MCP tool (#782) (#847)
- Miner write-tools — local-execution action specs (#780) (#848)
- Multi-step plan DAG tools (#783) (#849)
- Harness adapter — miner-auto-dev profile + driving loop (#781) (#850)
- MCP automation-state read tool (advances #784) (#851)
- Maintainer CLI controls — maintain status/approve/reject/pause/resume (#852)
- CLI set-level + MCP propose-action — non-dashboard #784 surfaces (#854)
- Wire issue-discovery/issue-spam scoring constants into engine (#835)
- Audit repository-settings flag enforcement (Fixes #797) (#915)
- Approval-queue control tools — list + decide pending agent actions (#784) (#934)
- Agent audit feed — surface executed actions + approval decisions (#784) (#937)
- Slop signal — generic/empty commit message (#564) (#938)
- Slop signal — no linked issue without rationale (#562) (#962)
- Model upstream review-collateral and non-code caps (Fi… (#1049)
- Expose outcome calibration via gittensory_get_outcome_calibration (#1174)
- Add draft-PR awareness to classification and queue health (#1189)
- Add selfAuthoredLinkedIssueGateMode with config-as-code parity (#1198)
- DB-backed global kill-switch (instant freeze, no redeploy) (#1243)
- Surface fleet calibration analytics via dashboard + MCP (#1268)
- Add .gittensory.yml review.profile (chill / balanced / assertive) (#review-profile) (#1347)
- Add .gittensory.yml review.path_instructions (per-path AI review rules) (#review-path-instructions) (#1350)
- Add .gittensory.yml review.exclude_paths (skip files from AI review) (#review-exclude-paths) (#1353)
- Add .gittensory.yml review.pre_merge_checks (deterministic pre-merge assertions) (#review-pre-merge-checks) (#1357)
- Add container-private per-repo config dir (#1390)
- Predict the manifest path policy + path-gated pre-merge checks via changedPaths (#1413)
- Add the per-repo contributor blacklist config layer (#1425) (#1429)
- Add configurable per-repo blacklistLabel (#1425) (#1430)
- Wire contributor validity floors into score preview (#808) (#1284)
- Delegate isTestFile to test-evidence isTestPath (#1306)
- Reward-risk severity taxonomy, opportunity factors, eligibility gap (#816) (#1351)
- Expose maintainer queue-noise triage via gittensory_get_maintainer_noise (#1414)
- Emit structured inline review findings + a review.inline_comments toggle (#1525)
- Per-repo feature config + all-authors AI review + RAG embed stack (#1555)
- Make the owner-PR close-exemption per-repo configurable (closeOwnerAuthors) (#1556)
- Per-repo .gittensory.yml review.instructions for grounded reviews (#1579)
- Per-repo review CLAUDE.md + skill library from the container-private config dir (#1580)
- Size + guardrail manual-review HOLD in the disposition (advisory-friendly) (#1584)
- Dry-run disposition — render the would-be merge/close/manual verdict without enforcing (#1588)
- Expose maintainer-lane triage via gittensory_get_maintainer_lane (#1456)
- Gate AI close on a calibrated, configurable confidence threshold (#1599)
- Expose repo label-policy audit via gittensory_get_label_audit (#1461)
- Let doctor --exit-code gate CI with a non-zero exit on failure (#1444)
- Add PowerShell shell completion (#1448)
- Wire Codex reviews and secure observability (#1678)
- Add VS Code host to init-client config (#1770)
- Add cache list to inspect cached decision packs (#1800)
- Suggest the closest command on an unknown command (#1868)
- Surface the non-code line cap in the score breakdown (#1978)
- Surface the saturated base-score value in the score breakdown (#2356)
- Add contributorOpenPrCap/contributorOpenIssueCap config (#2270) (#2467)
- Auto-close a contributor's PR over the open-PR cap (#2270) (#2479)
- Add a review-request nagging cooldown (#2463) (#2530)
- Re-check migration-file collisions against live main before merge (#2550) (#2585)
- Force a fresh rebase + CI recheck immediately before merge when base has advanced (#2616)
- Classify supported-but-outdated MCP clients as stale (#2622)
- Add lint-pr-text CLI for pre-push PR text checks (#2623)
- Add an account-age throttle for ban-evasion (#2642)
- Generalize the review-nag cooldown into a per-command rate limit (#2637)
- Add a security-focused review profile toggle (#2675)
- Add a lockfile-tamper-risk check (#2676)
- Expose dual-AI combine strategy as a per-repo setting (#2677)
- Add slop-risk CLI for pre-push slop self-checks (#2655)
- Cancel in-flight CI runs when a PR is auto-closed for the contributor cap (#2662)
- Add gittensory_find_opportunities to the stdio surface (#2694)
- Add a CLA / license-compatibility gate dimension (#2679)
- Add analyze and prepare plan-DAG templates to the shared engine (#2718)
- Gate priority label on linked-issue label propagation (#2750)
- Add issue-slop CLI for issue-quality self-checks (#2772)
- Add a modular moderation-rules engine with a cross-repo violation ledger (#2746)
- Add review.enrichment analyzer per-lane toggles (#2808)
- Make orb check publication configurable (#2863)
- Add .gittensory.yml surface to enable/scope repo-doc generation (#3169)
- Scheduled + on-demand refresh for repo-doc generation (#3202)
- Support arbitrary self-host type labels (#3232)
- Auto-match PRs to open GitHub Milestones in suggest-mode (#3183) (#3256)
- Add Linear backend for project/milestone matching (#3290)
- Add review-evasion protection (#3414)
- Add review.path_filters include/negation globs (#2043) (#3494)
- Add review.auto_review eligibility filters (#1954) (#3499)
- Add auto_pause_after_reviewed_commits knob (#2042) (#3503)
- Add review.tone public-safe voice brief knob (#2044) (#3507)
- Skip ignored auto-review authors (#3508)
- Add review.labeling_rules deterministic label suggestions (#2045) (#3534)
- Hold PRs that solve an unlinked open issue (#3513)
- Add per-repo review.ai_model overrides for claude-code/codex (#3570)
- Render AI-suggested fixes as GitHub suggested-change blocks (#3577)
- Render a deterministic changed-files summary in the unified comment (#1957) (#3604)
- Tag AI review findings with a category taxonomy (#1958) (#3634)
- Add per-repo review.visual capture config (#3644)
- Add review.linkedIssueSatisfaction knob (off/advisory/block, default off) (#2173) (#3665)
- Add deterministic review-effort chip and wire real per-PR minutes (#3666)
- Add review.visual.themes config for dark-mode capture (#3680)
- Skip auto-review when a configured label is present via review.auto_review.skip_labels (#3686)
- Skip auto-review of docs-only PRs via review.auto_review.skip_docs_only (#3690)
- Size-cap eligibility guard for auto-review via max_added_lines / max_files (#3693)
- Post a quiet "review skipped (reason)" status when auto-review eligibility fails (#3694)
- Add scroll-through GIF evidence capture (#3612) (#3688)
- Add review.min_finding_severity display floor for inline findings (#3718)
- Add review.max_findings display caps for blockers/nits (#2049) (#3783)
- Compose preflight, slop-risk, and pr-text-lint into review-pr (#3791)
- Add boundary-safe test-generation advisory (#1972) (#3794)
- Add maintainer review recap digest builder + Discord delivery (#3801)
- Boundary-safe test-generation spec + framework detector (#3795)
- Add review.comment_verbosity output-detail knob (#3804)
- Deterministic impact map (#2182-#2186) (#3796)
- Add cached repo quality-culture profile as AI-review grounding (#3802)
- Add review.fixHandoff toggle (default off) for fix-handoff blocks (#2176) (#3824)
- Add follow-up issue local-write action spec (#2177) (#3836)
- Add suppression-signal data model + memory matcher (#3841)
- Add fix-handoff block renderer + follow-up-issue MCP spec (#3834)
- Add public per-repo review-quality leaderboard (#2568) (#3846)
- Add review.auto_merge_summary read-only knobs surface (#2051) (#3855)
- Validate .gittensory.yml against schema (fail clearly pre-review) (#3823)
- Extract scoring preview/model into gittensory-engine (#2282) (#3849)
- Add opt-in oldest-first ordering mode to selectRegateCandidates (#3815) (#3867)
- Add config-driven before/after screenshot-table gate (#3877)
- Per-category inline-comment cap (#2159) (#3874)
- Extract focus-manifest parse/compile core (#2280) (#3891)
- Add gittensory_find_opportunities to hosted Worker (#2308) (#3986)
- Add review.shared_config operator overlay (#2046) (#3995)
- Add gittensory_validate_config tool for .gittensory.yml (#4049)
- Wire linked-issue satisfaction into the deterministic gate (#4069)
- Upgrade inlineComments + fixHandoff to full config-as-code substitutes (#4116)

### Fixes
- Report package version 0.6.0 (#751)
- Resolve contributor confirmation for gate prediction (#715)
- Match upstream gittensor constant name + fallback value (#815)
- Authenticate public GitHub profile fetches (#819)
- Require live write access for staged actions (#859)
- Debounce miner dashboard refresh jobs (#867)
- Apply time decay to score breakdown (#881)
- Redact private preflight workspace signals (#885)
- Fail closed on branch eligibility (#891)
- Keep public-safe packets free of private evidence (#892)
- Keep predicted gate on public manifest (#903)
- Avoid request-time burden forecast scans (#906)
- Redact private rerun hints from PR packet (#907)
- Include rejected feedback outcomes (#914)
- Keep PR body draft taxonomy public-safe (#909)
- Count pending approvals accurately (#878)
- Cap contributor graph file path loading (#894)
- Avoid public manifest cache poisoning (#922)
- Wire open-PR pressure scenarios into the branch scenario summary (#348) (#923)
- Scope open PR pressure count to repo (#939)
- Compare local branch repo names case-insensitively (#965)
- Gate approval queue by repo maintainer scope (#941)
- Wire trusted open issue counts (#940)
- Include open issue counts in score breakdown (#971)
- Surface snapshot warnings in previews (#985)
- Apply penalty label multipliers instead of flooring to 1 (#1038)
- Cap non-code explicit totals (#1102)
- Gate non-confirmed contributors normally (eliminate the manual-review backlog) (#1140)
- Blunt slop oracle score output and add per-actor tool rate-limit (#1194)
- Guard credibility against non-finite stale and unlinked counts (#1155)
- Single-source fallbacks from DEFAULT_SCORING_CONSTANTS (Fixes #812) (#1240)
- Linear-time manifest glob matcher (ReDoS) + **/ matches root + glob length cap (#1366)
- Redact /root/ local paths on the public-safety boundary (#1376)
- Protect private policy surfaces (#1405)
- Match labelMultipliers keys as fnmatch globs (#1273) (#1277)
- Truncate per-repo grace_period_hours to int for upstream parity (#1320) (#1326)
- Report real changed line counts for renamed files (#1379)
- Bound predict gate changed paths (#1438)
- Gate maintainer noise behind maintainer access (#1464)
- Preserve segment boundaries for globstar paths (#1426)
- Harden label glob translation (#1450)
- Preserve cached review instructions (#1586)
- Anchor the draft title pattern to genuine markers (#1529)
- Add shared/global contributor blacklist (#1531)
- Redact /root/ and forward-slash Windows paths in the manifest public-safe guard (#1688)
- Preserve repo casing for open PR lookups
- Clamp fixed_base_score and SRC_TOK_SATURATION_SCALE to documented bounds (#1744) (#1745)
- Redact /var/ paths in the manifest public-safe guard (#1749)
- Centralize public local-path redaction across drifted surfaces (#1748)
- Match configured label globs in config quality and label audit (#1769) (#1774)
- Reduce rate-limit retry storms (#1866)
- ParseGitRemote accepts trailing-slash GitHub URLs (#1887)
- Align maintainer digest failing-check detection with readiness classifier (#1902)
- Count focused validation runs as passing evidence (#1912)
- Avoid regex slash trimming in remote parsing (#1947)
- Word-boundary linked-issue closing keywords (#1988)
- Pin gittensory_propose_action to the PR's current head (#2355)
- Scope the static MCP token to an operator-configured repo allowlist (#2274)
- Count cypress/e2e and snapshot paths as test files (#2120)
- Downgrade readiness gate mode block to advisory (#2384)
- Mark gate.firstTimeContributorGrace as reserved/inert (#2411)
- Distinguish an executor error from a clean accept (#2428)
- Honor settings.commandAuthorization in .gittensory.yml (#2385)
- Scope GITTENSORY_MCP_TOKEN read access to an operator allowlist (#2464)
- Cap labelPatternToRegExp wildcard groups to prevent ReDoS (#2482)
- Bound label pattern cache (#2513)
- Match label history against config labels case-insensitively (#2580)
- Wire badgeEnabled into the .gittensory.yml manifest parser (#2598)
- Parse gate tri-state modes case-insensitively in manifest (#2612)
- Cap review-nag cooldown (#2634)
- Classify .mjs/.cjs/.mts/.cts as code and test files (#2665)
- Scope label automation for one-shot reviews (#2719)
- Decouple taxonomy labels from outcome labels (#2735)
- Derive direct-PR lane preference from public-safe test expectations (#2792)
- Re-sync isTestFile with the server isTestPath (pytest prefix + JVM/C#/Swift) (#2753)
- Count C#/Swift/Groovy source as code files (#2776)
- Re-sync score-preview classifiers with the server test/code conventions (#2822)
- Bind CLA checks to trusted app slug (#2815)
- Keep review queue live and verify configured CI (#2843)
- Classify PHP source files as code (#2845)
- Route repository-settings reads through the resolver, not the raw DB accessor (#2920)
- Make guardrails and review labels configurable (#2943)
- Clamp time-decay override params to their documented bounds (#703) (#2948)
- Reuse test matcher for branch summaries (#2964)
- Keep label classes with a literal dash after a range matchable (#2973)
- Bound lint-pr-text body file reads (#2945)
- Make hard guardrails authoritative (#2974)
- Classify native source for test evidence (#2979)
- Make guardrail paths config-only (#2981)
- Order prerelease identifiers by semver precedence (#3049)
- Use precision-safe numeric comparison in the CLI update-check semver comparator (#3053)
- Tighten reward labels and linked issue gates (#3067)
- Exempt the maintainer lane from the issue-discovery validity floor (#3071)
- Keep focus-areas guidance for the public-safe wanted paths (#3079)
- Classify Dart/Flutter *_test.dart files as tests (#3092)
- Reject non-positive or non-finite label multipliers before they reach the score formula (#3124)
- Classify PHP preview tests (#3223)
- Classify Vue/Svelte/Astro across all code classifiers (#3292)
- Classify .cc and .hpp C++ source across all classifiers (#3301)
- Classify Dart source across all code classifiers (#3316)
- Explain validation and guardrail holds (#3304)
- Bound custom type label cleanup (#3552)
- Clamp visual route capture limit (#3697)
- Move isTestFile/isCodeFile out of local-branch.ts to unbreak ui:typecheck (#3709)
- Hold required AI skips from PR metadata (#3721)
- Exclude generated Dart from code scoring (#3724)
- Sanitize follow-up issue paths (#3970)
- Map review preflight status (#3972)
- Keep boundary suggestions source-free (#3955)
- Apply the no-issue-rationale exemption to all linked-issue findings (#4064)
- Sanitize validate-config terminal output (#4090)
- Bound opportunity target fanout (#4072)
- Build gittensory-engine before the publish gate + switch to workflow_dispatch (#4135)

### Security
- Bound focus manifest ingestion (#890)

### Refactors
- Remove metagraphed-specific hardcoding from the registry-review engine (#2443)
- Extract gate:-to-settings override mapping into its own function (#3373)

### Dependencies
- Update MCP release dependency stack (agents ^0.13.3 -> ^0.17.3)

### Chores
- Update github actions (#997)
- Update github actions to v6 (#1009)
- Update github actions to v7 (#1031)
- Update github actions to v24.18.0 (#1723)

## mcp-v0.6.0 - 2026-06-14

### Features
- Add missing test evidence slop signal (#616)
- Gittensory_validate_linked_issue linked-issue multiplier validator (#622)
- Gittensory_check_before_start pre-start duplicate/solvability check (#621)
- Authoritative .gittensory.yml gate config (config-as-code) (#647)
- Dual-AI maintainer review + BYOK (Phase C) (#652)
- Config-as-code provider/model + maintainer self-serve BYOK routes (#664)
- Event→subscription→delivery service + MCP badge feed (closes #536, advances #535) (#707)
- Policy-pack-pluggable gate — gittensor + oss-anti-slop packs (#692) (#710)
- Agent-native pre-submission self-check as a general product (#693) (#712)
- Surface the earn-on-Gittensor path for oss-anti-slop adopters (#694) (#713)
- Miner-facing post-merge reward & outcome attribution (#702) (#714)
- Wire + modernize the deterministic slop score into the gate, context & MCP (#530/#531/#532) (#716)
- AI-assisted advisory slop layer (advisory-only, never blocks) (#724)
- Issue-side slop triage (#533) (#729)
- Model upstream time-decay, applied behind a default-off flag (#703) (#731)
- Gittensory_lint_pr_text commit/PR-body rubric linter (#634)
- Per-repo time-decay hyperparameters + go live (#703) (#733)
- Active issue-watch monitor — gittensory_watch_issues (#699 path B) (#735)
- Slop self-check tools + release @jsonbored/gittensory-mcp v0.6.0 (#745)

### Fixes
- Bound local branch scenario inputs (#614)
- Harden manifest public-safe filter (#659)
- Enforce repo scope for gate prediction (#717)
- Bound mark-read ids (#718)
- Visibility-aware access gate for subscriptions + fan-out (#742)

### Refactors
- Shared public-safe redaction module (#542) (#743)

### Chores
- Add outputSchema to every tool that lacks it (#637)

## mcp-v0.5.0 - 2026-06-12

### Features
- Cache last-good decision packs (#266)
- Add risk-adjusted action portfolio (#219)
- Summarize repo tradeoffs (#323)
- Add multi-account profile support (#263)
- Add agent action explanation cards (#232)
- Add recommendation outcome feedback (#229)
- Add duplicate and stale-work scenario blockers (#346)
- Add structured output schemas for existing tools (#344)
- Add miner planning prompts (#342)
- Define focus-manifest policy schema (#339)
- Persist recommendation outcome events (#334)
- Persist privacy-safe role on product usage events (#355)
- Feed aggregate outcome quality into confidence (#332)
- Add version command and clearer unknown-command guidance (#333)
- Add roots-aware workspace detection (#364)
- Add safe planning elicitation (#371)
- Add recommendation snapshot ids (#374)
- Add counterfactual reasons (#361)
- Add native resources, prompts, and structured output schemas (#360)
- Add queue pressure trend windows (#368)
- Add public-safe PR body drafting command (#382)
- Add shell completion command for bash, zsh, and fish (#400)
- Group doctor onboarding checks (#421)
- Add config command reporting resolved configuration provenance (#335)
- Derive contribution lanes from focus manifests (#337)
- Wire policy compiler into registration readiness (#350)
- Add contribution policy snapshot API (#369)
- Add Gittensory repo focus manifest (#118) (#389)
- Render public-safe scenario summaries (#416)
- Require 0.5.0 as the current supported client

### Fixes
- Surface npm latest across ui (#258)
- Scope decision-pack cache to auth token (#314)
- Remove default profile session cleanly (#327)
- Align registry changes output schema (#366)
- Enforce workspace roots for structured local status
- Include completion command in shell completions
- Shell-quote doctor next commands (#439)
- Report source upload env in config (#441)
- Clamp lane shares to match preview math (#453)
- Base open-PR threshold on merged history only (#455)
- Scope issue-quality reports to repo access (#483)
- Scope MCP repo access (#484)
- Preserve HTTP status for non-JSON errors (#489)
- Keep repo outcome patterns private (#493)
- Bound duplicate detection inputs (#497)
- Require solved-by-PR evidence for linked issues (#506)
- Reject prototype agent profile names (#507)
- Include config in completions (#509)
- Wire duplicate risk preview input (#512)
- Redact windows home paths in public PR packets (#514)
- Subject over-long manifest entries to dedup and list cap (#524)

### Security
- Bound focus manifest ingestion (#494)

## mcp-v0.4.0 - 2026-06-02

### Features
- Add lifecycle watcher signals (#29)
- Add local workspace intelligence v2 (#70)
- Monitor open PRs and wire into decision packs (#72)
- Validate linked issue multiplier (#179)
- Classify control-panel roles (#189)
- Add privacy-safe usage event spine (#182)
- Track MCP compatibility adoption (#185)
- Ingest maintainer focus manifests for repo-specific guidance (#191)
- Learn accepted and rejected PR patterns by repo (#75)
- Model branch eligibility for issue PRs (#178)
- Add recommendation confidence provenance (#226)
- Add contributor evidence graph (#218)
- Require 0.4.0 as the current supported client

### Fixes
- Saturation-model contribution bonus capped at 5 instead of 25 (#181)
- Bound local scorer warning diagnostics (#210)
- Scope open PR monitor public actions (#208)
- Pending-PR projection double-counting merge-ready PRs (#222)

### Security
- Keep maintainer notes out of branch guidance (#213)

### Docs
- Add coverage buffer and contributor test-quality guidance (#55)

### Dependencies
- Update MCP release dependency stack (@modelcontextprotocol/sdk 1.26.0 -> 1.29.0, zod ^3.25.76 -> ^4.4.3, @asteasolutions/zod-to-openapi ^7.3.4 -> ^8.5.0, agents ^0.7.9 -> ^0.13.3)

## mcp-v0.3.0 - 2026-05-31


### Features

- Detect stale installs and API compatibility in doctor and status (#28)

- Generate public-safe pr packets (#53)

- Harden local scorer adapter setup (#27)

- Parse validation command summaries (#121)



### Fixes

- Isolate release write token

- Keep repo root out of API payloads

- Block snake case private PR packet signals


## mcp-v0.2.0 - 2026-05-28


### Features

- Add deterministic base-agent orchestrator (#14)



### Fixes

- Create GitHub releases for MCP tag publishes

- Use first-level api domain

- Ignore stale beta api origins


## mcp-v0.1.4 - 2026-05-26


### Features

- Add public registration polish gates


## mcp-v0.1.3 - 2026-05-26


### Features

- Add install site and mcp diagnostics

- Add situational score projections
