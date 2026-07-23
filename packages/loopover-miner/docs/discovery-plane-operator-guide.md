# Hosted discovery plane — operator guide (opt-in)

> Also published on the docs website: [Hosted discovery plane](https://loopover.ai/docs/ams-discovery-plane)
> (same content, rendered with search and the rest of the maintainer docs nav). This file remains
> the canonical source and ships inside the published `@loopover/miner` package.

Operator-facing guide for the **optional** Phase 6 hosted discovery-index plane ([#4250](https://github.com/JSONbored/loopover/issues/4250)). This is the client/miner half of that roadmap item: how a `loopover-miner` instance opts in, what it may send, and what never leaves the operator's machine.

> **Status: shipped and live.** The request/response contract, the client (`packages/loopover-miner/lib/discovery-index-client.ts`), and the hosted server (`packages/discovery-index`, deployed at `discovery.loopover.ai`) are all real and running. The walkthrough below reflects the actual opt-in mechanism, not a plan.
>
> | Defines                                                                                                                                                | Status                                                                                                                                                                                                                                                                             |
> | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Public-data-only discovery-index API contract — `DiscoveryIndexQuery` / `DiscoveryIndexResponse` / `DiscoveryIndexCandidate` (request/response shapes) | ✅ **shipped**, stable at `DISCOVERY_INDEX_CONTRACT_VERSION` 1 — [`discovery-index-contract.ts`](../../loopover-engine/src/discovery-index-contract.ts), [`discovery-index-contract.md`](discovery-index-contract.md) ([#4300](https://github.com/JSONbored/loopover/issues/4300)) |
> | Anonymized telemetry event schema for the optional hosted plane                                                                                        | ✅ **shipped** — [`miner-telemetry.ts`](../../loopover-engine/src/miner-telemetry.ts) ([#4301](https://github.com/JSONbored/loopover/issues/4301)) — see the Telemetry section below for what's actually wired up today vs. planned                                                |
> | Client-side soft-claim coordination request builder                                                                                                    | ✅ **shipped** — [`discovery-soft-claim.ts`](../../loopover-engine/src/discovery-soft-claim.ts) ([#4302](https://github.com/JSONbored/loopover/issues/4302))                                                                                                                       |
> | Hosted discovery-index server, deployed at `discovery.loopover.ai`                                                                                     | ✅ **shipped and deployed** — [#7167](https://github.com/JSONbored/loopover/issues/7167) (Cloudflare Container + Worker; see `packages/discovery-index/`)                                                                                                                          |
> | Miner-side opt-in wiring (the env vars below)                                                                                                          | ✅ **shipped** — [`discovery-index-client.ts`](../../loopover-miner/lib/discovery-index-client.ts), gated at the call site in `attempt-cli.ts` ([#7168](https://github.com/JSONbored/loopover/issues/7168))                                                                        |

Part of the Miner Wave 2 discovery plane ([#2353](https://github.com/JSONbored/loopover/issues/2353) Phase 6). Distinct from Phase 1's **local-only** metadata fan-out documented in [`cross-repo-discovery-phase1.md`](cross-repo-discovery-phase1.md) — that path never phones home today.

## Default posture: opt-in (not like Orb)

Two telemetry/export surfaces exist in LoopOver, and they intentionally use **opposite defaults**:

| Surface                                                     | Default                                | Operator action                                                        | Precedent                                                                                          |
| ----------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Orb fleet calibration** (`src/selfhost/orb-collector.ts`) | **ON** once a GitHub App is configured | Opt out only via `ORB_AIR_GAP=true` (air-gapped / send-nothing)        | Review-stack self-host contract — export is always on unless air-gapped                            |
| **Hosted discovery plane** (this guide)                     | **OFF**                                | Opt **in** explicitly before any hosted index query or plane telemetry | Hybrid, self-host-first miner deployment — participation in a shared hosted plane is never assumed |

Do **not** copy Orb's wording for this plane. Orb's header comment is explicit: "Export is ALWAYS ON… there is no opt-out flag" aside from `ORB_AIR_GAP`. The discovery plane is the opposite: **no hosted traffic unless the operator turns it on.**

## What the plane is for

When enabled, a miner may query a **shared, metadata-only** discovery index instead of every fleet member independently fanning out GitHub search/listing calls against the same repos — mitigating cross-fleet rate-limit pressure (the same class of incident addressed for the review stack in [#1936](https://github.com/JSONbored/loopover/issues/1936)).

The plane:

- Serves **public GitHub metadata only** (issue titles, labels, counts, timestamps, URLs — the same class of fields Phase 1 already uses locally).
- May coordinate **soft claims** across the fleet, server-side dedup included ([#4250](https://github.com/JSONbored/loopover/issues/4250); client request shape is [#4302](https://github.com/JSONbored/loopover/issues/4302)).
- Never receives source trees, diffs, tokens, or write credentials.

Local discovery (`opportunity-fanout` + `opportunity-ranker`) continues to work with **zero** hosted configuration.

## Opt-in mechanism

Real, shipped env vars, read in [`discovery-index-client.ts`](../../loopover-miner/lib/discovery-index-client.ts):

| Variable                                 | Default         | Purpose                                                                                                                                                                                                                                              |
| ---------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOPOVER_MINER_DISCOVERY_PLANE`         | unset / `false` | Master opt-in. When not truthy (`1`, `true`, `yes`, `on`), the miner never calls the hosted index and never emits discovery-plane telemetry.                                                                                                         |
| `LOOPOVER_MINER_DISCOVERY_INDEX_URL`     | unset           | Hosted index base URL. Set this to `https://discovery.loopover.ai` to use the maintainer-run instance, or point it at your own deployment of `packages/discovery-index`. Required when the plane is enabled; ignored when opt-in is off.             |
| `LOOPOVER_MINER_DISCOVERY_SHARED_SECRET` | unset           | Bearer token sent as `Authorization: Bearer <value>` on every request to the hosted index. Optional against a server that doesn't require it; the maintainer-run instance at `discovery.loopover.ai` does — ask the operator running it for a value. |
| `LOOPOVER_MINER_DISCOVERY_TELEMETRY`     | unset / `false` | Separate opt-in for operational telemetry. Plane queries can stay on while telemetry stays off. **Currently local-only** — see Telemetry below.                                                                                                      |

**Truthy-string convention:** `/^(1|true|yes|on)$/i`, matching other `LOOPOVER_*` flags in this repo.

**Operator checklist (enabled plane):**

1. Set `LOOPOVER_MINER_DISCOVERY_PLANE=true`.
2. Set `LOOPOVER_MINER_DISCOVERY_INDEX_URL=https://discovery.loopover.ai` (or your own deployment's URL).
3. Set `LOOPOVER_MINER_DISCOVERY_SHARED_SECRET` if the index you're pointing at requires one.
4. Optionally set `LOOPOVER_MINER_DISCOVERY_TELEMETRY=true` for local operational log lines about plane usage — not required for index queries.
5. Keep `GITHUB_TOKEN` (or equivalent) on the instance only; never configure tokens intended for the hosted plane to receive.
6. Run `loopover-miner discover <owner/repo> --dry-run --json` and check the response for hosted-index candidates alongside your local fan-out to confirm the plane is actually being queried.

Every call in the client is fail-open: a network error, timeout, or non-2xx response degrades silently to "no supplement" rather than failing the miner's own discover/attempt work. With opt-in off (default), behavior is byte-identical to today: local SQLite ledgers, local fan-out, no hosted calls.

## Contrast with local soft-claims today

`packages/loopover-miner/lib/claim-ledger.js` records soft claims **locally only** ("never uploads, syncs, or phones home"). Fleet-wide coordination before work starts is what [#4302](https://github.com/JSONbored/loopover/issues/4302) + the hosted index ([#4250](https://github.com/JSONbored/loopover/issues/4250)) add **on top of** that ledger — only after explicit opt-in.

After-the-fact duplicate adjudication (`isDuplicateClusterWinnerByClaim` in `@loopover/engine`) remains separate; it resolves collisions by observing what publicly landed first, not by preventing overlap up front.

## Invariants

Mirrors [`DEPLOYMENT.md`](../DEPLOYMENT.md) tone — concrete guarantees for operators:

- **Default OFF** — no hosted discovery-index traffic and no discovery-plane telemetry unless the operator opts in.
- **Metadata-only index queries** — responses are issue/listing metadata compatible with local `normalizeCandidate` shape; no source upload, no clone, no repo archive.
- **Read-only client posture** — the miner uses GET/list/search semantics toward GitHub directly (Phase 1) and toward the hosted index when enabled; the plane does not grant the miner new GitHub write capability.
- **Credentials stay local** — GitHub tokens, PATs, and actor-capable secrets are injected at runtime on the operator's machine or secret store; they are **never** included in index or telemetry payloads.
- **No compensation signals in the plane** — raw reward values, wallet addresses, hotkeys, trust scores, or private rankings never cross this boundary (same public boundary as [`cross-repo-discovery-phase1.md`](cross-repo-discovery-phase1.md) Acceptance).
- **Telemetry is a second opt-in** — even with the plane enabled, telemetry remains separately gated behind `LOOPOVER_MINER_DISCOVERY_TELEMETRY`.
- **Core miner still works offline** — claims, plans, queues, and local ledgers do not require the hosted plane; `loopover-miner doctor` / `status` remain no-network commands.

### Telemetry: local today, not yet sent to the hosted service

`recordDiscoveryTelemetry` (`discovery-index-client.ts`) currently emits a structured **local log line** (`event`, `outcome` — both fixed, low-cardinality strings; no repo/issue identifiers, no free text) via the miner's own logger. No hosted telemetry-collector endpoint exists yet, so nothing about telemetry events leaves the operator's machine today regardless of this flag. The originally planned design called for HMAC-hashed repo/issue correlation identifiers once a real collector ships — that collector doesn't exist yet, so there is nothing to hash today; this section will be updated again once it does.

### Never included (client → hosted plane)

Inventory style matches `src/selfhost/orb-collector.ts:15-17` ("No diffs, no code…") adapted for discovery-plane domain ([#4301](https://github.com/JSONbored/loopover/issues/4301)):

- Source file contents, patches, or diffs
- Full issue/PR bodies or review comments
- GitHub tokens, PATs, App private keys, or any actor-capable credential
- Commit SHAs, branch names tied to unpublished work, or CI log excerpts
- Operator login identities, emails, or hostnames usable as PII
- Raw gate reasons, model transcripts, or free-text maintainer notes
- Reward amounts, wallet addresses, hotkeys, trust scores, or private rankings

### Never retained by the hosted service (server-side)

The server (`packages/discovery-index`) never holds source or actor-capable credentials — see `packages/discovery-index/README.md` and `OPERATIONS.md` for the server's own boundary and incident-response documentation. This client guide does not define server retention policy in detail.

## Related docs

- [`cross-repo-discovery-phase1.md`](cross-repo-discovery-phase1.md) — local, metadata-only Phase 1 discovery (no hosted plane).
- [`operations-runbook.md`](operations-runbook.md) — SQLite concurrency, corruption recovery, multi-process collisions, post-upgrade migration ([#4875](https://github.com/JSONbored/loopover/issues/4875)).
- [`miner-goal-spec.md`](miner-goal-spec.md) — per-repo `.loopover-miner.yml` targeting policy.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — laptop vs fleet deployment and core miner invariants.
