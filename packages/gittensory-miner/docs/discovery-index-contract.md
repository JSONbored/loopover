# Discovery-index API contract

The **discovery-index contract** is the typed request/response shape a miner uses to query the *optional* hosted
discovery-index service. It is defined in `@jsonbored/gittensory-engine`
(`packages/gittensory-engine/src/discovery-index-contract.ts`) so both sides — this repo's future server
implementation ([#4250](https://github.com/JSONbored/gittensory/issues/4250), maintainer-only, explicitly blocked
on this contract) and any client — build against one shape.

This is **schema/shape only**: no server, no deployed endpoint, no client HTTP implementation (those are #4250 and
the sibling soft-claim-coordination issue, respectively).

## Why

The plane mitigates the rate-limit incident already fixed once for the review stack
([#1936](https://github.com/JSONbored/gittensory/issues/1936)): *one* shared GitHub-metadata crawler across the
miner fleet instead of every miner instance independently hammering the same repos' search/listing endpoints. The
existing single-instance client pipeline (`packages/gittensory-miner/lib/opportunity-fanout.js` +
`opportunity-ranker.js`) is what a hosted version must stay compatible with, so the response candidate shape is
field-for-field compatible with `opportunity-ranker.js`'s `normalizeCandidate` — a miner can swap a local fan-out
for a hosted query without the ranker changing.

## Boundary (Phase 1)

The contract stays inside the Phase 1 discovery boundary
([`cross-repo-discovery-phase1.md`](./cross-repo-discovery-phase1.md)): metadata-only, GET/list/search-only, and
**no raw scores, rewards, wallet/hotkey data, or source contents** cross the public boundary. This is enforced in
code, not just documented: `discoveryIndexBoundaryViolations` lists any forbidden field on a raw object, and
`normalizeDiscoveryIndexCandidate` **rejects** (returns `null`) — rather than silently trimming — any candidate
carrying one, so a misbehaving server cannot smuggle economic/identity/source data past the contract.
`DISCOVERY_INDEX_FORBIDDEN_FIELDS` is the fragment list (`score`, `reward`, `wallet`, `hotkey`, `coldkey`,
`mnemonic`, `payout`, `ranking`, `rawtrust`, `trustscore`, `sourcecontent`, `diff`, `patch`).

## Request — `DiscoveryIndexQuery`

Every field is optional; a malformed value degrades to a documented default with a warning rather than throwing
(`normalizeDiscoveryIndexRequest`).

- **`repos`** — canonical `owner/repo` targets. Non-string / non-`owner/repo` entries are skipped; deduplicated;
  capped at 200. Default: `[]`.
- **`orgs`** — bare `owner` (org/user) targets. Entries containing `/` are skipped; deduplicated; capped at 200.
  Default: `[]`.
- **`searchTerms`** — free-text GitHub issue-search terms. Blank entries skipped; deduplicated; capped at 200.
  Default: `[]`.
- **`limit`** — page size, floored and clamped to `[1, 200]`; a non-numeric value warns and falls back. Default:
  `50`.
- **`cursor`** — opaque forward pagination cursor from a previous response's `nextCursor`; a blank/non-string value
  becomes `null`. Default: `null`.

## Response — `DiscoveryIndexResponse`

- **`candidates`** — a list of `DiscoveryIndexCandidate`. `normalizeDiscoveryIndexResponse` keeps only valid,
  public-safe entries and drops invalid or boundary-violating ones with a warning.
- **`nextCursor`** — forward cursor for the next page, or `null` when the result set is exhausted.
- **`contractVersion`** — `DISCOVERY_INDEX_CONTRACT_VERSION` (currently `1`).

### `DiscoveryIndexCandidate`

Metadata-only, field-for-field compatible with `opportunity-ranker.js` `normalizeCandidate`:
`owner`, `repo`, `repoFullName`, `issueNumber`, `title`, `labels`, `commentsCount`, `createdAt`, `updatedAt`,
`htmlUrl`, `aiPolicyAllowed`, `aiPolicySource` (`"AI-USAGE.md" | "CONTRIBUTING.md" | "none"`).
