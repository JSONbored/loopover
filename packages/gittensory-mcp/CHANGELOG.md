# Changelog

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
- Slop-risk + issue-slop self-check tools in the npm package

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
