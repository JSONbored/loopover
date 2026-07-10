# Hosted discovery plane — operator guide (opt-in)

Operator-facing guide for the **optional** Phase 6 hosted discovery-index plane ([#4250](https://github.com/JSONbored/gittensory/issues/4250)). This is the client/miner half of that roadmap item: how a `gittensory-miner` instance opts in, what it may send, and what never leaves the operator's machine.

> **Placeholder scope:** the concrete env var names, HTTP paths, and telemetry event types below are **provisional** until the sibling contract/telemetry/client issues land. When those ship, update this file to match the real symbols — do not treat the TBD names as stable API yet.
>
> | Issue | What it defines |
> |-------|-----------------|
> | [#4300](https://github.com/JSONbored/gittensory/issues/4300) | Public-data-only discovery-index API contract (request/response shapes) |
> | [#4301](https://github.com/JSONbored/gittensory/issues/4301) | Anonymized telemetry event schema for the optional hosted plane |
> | [#4302](https://github.com/JSONbored/gittensory/issues/4302) | Client-side soft-claim coordination request builder |
> | [#4250](https://github.com/JSONbored/gittensory/issues/4250) | Hosted discovery-index server (maintainer-operated counterpart) |

Part of the Miner Wave 2 discovery plane ([#2353](https://github.com/JSONbored/gittensory/issues/2353) Phase 6). Distinct from Phase 1's **local-only** metadata fan-out documented in [`cross-repo-discovery-phase1.md`](cross-repo-discovery-phase1.md) — that path never phones home today.

## Default posture: opt-in (not like Orb)

Two telemetry/export surfaces exist in Gittensory, and they intentionally use **opposite defaults**:

| Surface | Default | Operator action | Precedent |
|---------|---------|-------------------|-----------|
| **Orb fleet calibration** (`src/selfhost/orb-collector.ts`) | **ON** once a GitHub App is configured | Opt out only via `ORB_AIR_GAP=true` (air-gapped / send-nothing) | Review-stack self-host contract — export is always on unless air-gapped |
| **Hosted discovery plane** (this guide) | **OFF** | Opt **in** explicitly before any hosted index query or plane telemetry | Hybrid, self-host-first miner deployment — participation in a shared hosted plane is never assumed |

Do **not** copy Orb's wording for this plane. Orb's header comment is explicit: "Export is ALWAYS ON… there is no opt-out flag" aside from `ORB_AIR_GAP`. The discovery plane is the opposite: **no hosted traffic unless the operator turns it on.**

## What the plane is for

When enabled, a miner may query a **shared, metadata-only** discovery index instead of every fleet member independently fanning out GitHub search/listing calls against the same repos — mitigating cross-fleet rate-limit pressure (the same class of incident addressed for the review stack in [#1936](https://github.com/JSONbored/gittensory/issues/1936)).

The plane:

- Serves **public GitHub metadata only** (issue titles, labels, counts, timestamps, URLs — the same class of fields Phase 1 already uses locally).
- May coordinate **soft claims** across the fleet (server-side dedup is [#4250](https://github.com/JSONbored/gittensory/issues/4250); client request shape is [#4302](https://github.com/JSONbored/gittensory/issues/4302)).
- Never receives source trees, diffs, tokens, or write credentials.

Local discovery (`opportunity-fanout` + `opportunity-ranker`) continues to work with **zero** hosted configuration.

## Opt-in mechanism (names TBD — update when #4300/#4301 ship)

Until the contract issue lands, treat these as **documentation placeholders** for the shape operators should expect:

| Variable (provisional) | Default | Purpose |
|------------------------|---------|---------|
| `GITTENSORY_MINER_DISCOVERY_PLANE` | unset / `false` | Master opt-in. When not truthy (`1`, `true`, `yes`, `on`), the miner must not call the hosted index or emit discovery-plane telemetry. |
| `GITTENSORY_MINER_DISCOVERY_INDEX_URL` | unset | Hosted index base URL. Required when the plane is enabled; ignored when opt-in is off. |
| `GITTENSORY_MINER_DISCOVERY_TELEMETRY` | unset / `false` | Separate opt-in for anonymized operational telemetry ([#4301](https://github.com/JSONbored/gittensory/issues/4301)). Plane queries can stay on while telemetry stays off. |

**Truthy-string convention** (when implemented): `/^(1|true|yes|on)$/i`, matching other `GITTENSORY_*` flags in this repo.

**Operator checklist (enabled plane):**

1. Set `GITTENSORY_MINER_DISCOVERY_PLANE=true` (exact name may change — see [#4300](https://github.com/JSONbored/gittensory/issues/4300)).
2. Set `GITTENSORY_MINER_DISCOVERY_INDEX_URL` to the operator-trusted index endpoint ([#4250](https://github.com/JSONbored/gittensory/issues/4250)).
3. Optionally set `GITTENSORY_MINER_DISCOVERY_TELEMETRY=true` if you want anonymized operational events for the hosted service — not required for index queries.
4. Keep `GITHUB_TOKEN` (or equivalent) on the instance only; never configure tokens intended for the hosted plane to receive.

With opt-in off (default), behavior is byte-identical to today: local SQLite ledgers, local fan-out, no hosted calls.

## Contrast with local soft-claims today

`packages/gittensory-miner/lib/claim-ledger.js` records soft claims **locally only** ("never uploads, syncs, or phones home"). Fleet-wide coordination before work starts is what [#4302](https://github.com/JSONbored/gittensory/issues/4302) + the hosted index ([#4250](https://github.com/JSONbored/gittensory/issues/4250)) add **on top of** that ledger — only after explicit opt-in.

After-the-fact duplicate adjudication (`isDuplicateClusterWinnerByClaim` in `@jsonbored/gittensory-engine`) remains separate; it resolves collisions by observing what publicly landed first, not by preventing overlap up front.

## Invariants

Mirrors [`DEPLOYMENT.md`](../DEPLOYMENT.md) tone — concrete guarantees for operators:

- **Default OFF** — no hosted discovery-index traffic and no discovery-plane telemetry unless the operator opts in.
- **Metadata-only index queries** — responses are issue/listing metadata compatible with local `normalizeCandidate` shape; no source upload, no clone, no repo archive.
- **Read-only client posture** — the miner uses GET/list/search semantics toward GitHub directly (Phase 1) and toward the hosted index when enabled; the plane does not grant the miner new GitHub write capability.
- **Credentials stay local** — GitHub tokens, PATs, and actor-capable secrets are injected at runtime on the operator's machine or secret store; they are **never** included in index or telemetry payloads.
- **No compensation signals in the plane** — raw reward values, wallet addresses, hotkeys, trust scores, or private rankings never cross this boundary (same public boundary as [`cross-repo-discovery-phase1.md`](cross-repo-discovery-phase1.md) Acceptance).
- **Telemetry is a second opt-in** — even with the plane enabled, anonymized telemetry ([#4301](https://github.com/JSONbored/gittensory/issues/4301)) remains separately gated.
- **Anonymized identifiers only** — when telemetry ships, repo/issue correlation uses HMAC-hashed identifiers keyed by a **per-instance dedicated secret** the collector never holds (same posture as `getOrCreateAnonSecret` / `hmacField` in `src/selfhost/orb-collector.ts` — key separation from GitHub App / webhook secrets).
- **Low-cardinality reason buckets** — any free-text-adjacent telemetry fields use bucketed categories (Orb's `bucketReasonCode` pattern), not raw maintainer or model prose.
- **Core miner still works offline** — claims, plans, queues, and local ledgers do not require the hosted plane; `gittensory-miner doctor` / `status` remain no-network commands.

### Never included (client → hosted plane)

Inventory style matches `src/selfhost/orb-collector.ts:15-17` ("No diffs, no code…") adapted for discovery-plane domain ([#4301](https://github.com/JSONbored/gittensory/issues/4301)):

- Source file contents, patches, or diffs
- Full issue/PR bodies or review comments
- GitHub tokens, PATs, App private keys, or any actor-capable credential
- Commit SHAs, branch names tied to unpublished work, or CI log excerpts
- Operator login identities, emails, or hostnames usable as PII
- Raw gate reasons, model transcripts, or free-text maintainer notes
- Reward amounts, wallet addresses, hotkeys, trust scores, or private rankings

### Never retained by the hosted service (server-side — [#4250](https://github.com/JSONbored/gittensory/issues/4250))

The server operating doc (maintainer-only) will restate the same boundary: **never holds source or actor-capable credentials.** This client guide does not define server retention policy; see #4250 deliverables.

## Related docs

- [`cross-repo-discovery-phase1.md`](cross-repo-discovery-phase1.md) — local, metadata-only Phase 1 discovery (no hosted plane).
- [`miner-goal-spec.md`](miner-goal-spec.md) — per-repo `.gittensory-miner.yml` targeting policy.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — laptop vs fleet deployment and core miner invariants.
