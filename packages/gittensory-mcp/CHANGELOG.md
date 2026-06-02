# Changelog

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
