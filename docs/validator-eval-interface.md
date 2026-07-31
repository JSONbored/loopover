# LoopOver as an objective eval provider — mechanism proposal

> **DRAFT — deliberately unpublished.** This lives in the repo-root `docs/` tree, not in
> `apps/loopover-ui/content/docs/`, so it is not served on the site. It ships to the docs site only once
> the mechanism conversation with the subnet team concludes (#9215).
>
> **Scope:** mechanism only. Nothing here concerns emissions, pricing, or weight economics.

## What this is

A proposal for how an SN74 validator could consume LoopOver's scores for objective optimization, written so
it can be evaluated line by line rather than taken on trust.

Most of it already ships. Where something does not yet exist, this says so.

## 1. The artifact

An `EvalScoreRecord`, served today at `GET /v1/public/eval-scores`:

```jsonc
{
  "schemaVersion": 1,
  "subject":     { "kind": "agent", "id": "orb-gate" },
  "workUnit":    { "kind": "outcome_confirmed_precision", "ruleId": "ai_consensus_defect" },
  "score":       { "decided": 460, "confirmed": 287, "precision": 0.624,
                   "recall": null, "coverage": 1, "abstained": 0 },
  "commitments": { "corpusChecksum": "470e234e…", "scoringRuleVersion": "outcome-confirmed-precision-v1",
                   "windowStart": "…", "windowEnd": "…", "splitSeed": null, "heldOutFraction": null },
  "trust":       { "tier": "reproducible" },
  "issuedAt":    "…",
  "recordDigest": "5f998e79…"
}
```

Three properties matter to a consumer:

**`corpusChecksum` commits to bytes you can actually obtain.** It is the SHA-256 of the canonical JSON of the
corpus served at `/v1/public/eval-corpus?ruleId=…`. Download it, rehash it, compare. This is load-bearing and
was not always true: a commitment previously pointed at an internal artifact no reader could fetch, which is
a commitment to nothing. Fixed in #9962; a record whose corpus is empty, truncated, or unreadable is now
**omitted entirely** rather than published with a checksum that cannot be re-derived.

**`recall` is `null`, not zero.** The gate's rules fire deterministically — there is no abstention and no
false-negative population to measure. A `0` would be a claim; `null` is the absence of one. Likewise
`precision` is `null` below the sample floor rather than a masked zero.

**`recordDigest` is a hash, not a signature** — see §2.

## 2. Transport

Two surfaces.

**Pull API — shipped.** `/v1/public/eval-scores`, unauthenticated, cacheable. The low-latency path.

**Signed bundles — proposed.** The same records, batched periodically and signed with the **existing anchor
key**, already published at `/v1/public/decision-ledger/anchor-key` and already verifiable offline.

The reason for the second surface is a real gap, stated plainly: **records today are digest-committed but not
signed.** `recordDigest` proves a record is internally consistent and detects tampering *in a copy you already
trust*. It does not prove origin. The only signed artifact we currently publish is the ledger anchor
checkpoint. So a validator can today verify that a score is self-consistent and that its corpus rehashes, but
**cannot verify that we issued it**. Bundles close that with machinery that already exists and a key a
validator already has.

Bundle requirements:

- One signature over a canonical serialization of the batch — not per-record. `canonicalJson` is the
  repo-wide serialization rule; a consumer needs one rule, not two.
- The bundle commits to its window and its member digests, giving four independent checks: signature verifies
  under the published key → batch digest matches the records → each `recordDigest` recomputes → each
  `corpusChecksum` rehashes against a downloadable corpus. None requires trusting us.
- Freshness is stated, not implied. A bundle carries the instant it was cut; live data comes from the pull
  API. Conflating them is how a stale signed artifact gets read as current.
- Keys are selected by `keyId`, never by trying them all — a scan turns a real failure into an ambiguous one.
- A deployment with no signing key publishes **no bundle**, rather than an unsigned one.

On-chain commitment is **out of scope for v1**. It remains the natural upgrade if the subnet wants
commitments readable without depending on our availability.

## 3. What is scored, and what is not

**Offered now:** `outcome_confirmed_precision` — precision over the gate's own decisions, scored against what
realized history confirmed (merged / reopened / reverted / superseded).

**Offered later:** `benchmark_run`, from the frozen-repo harness (#9216). Same record shape, same transport.

**Not scored, and this is the honest half:**

- **Live-gate execution.** Recorded as not verifiable (#9141) and stated in those terms.
- **Anything about a private repository's contents.** The published corpus drops `targetKey` outright rather
  than hashing it — a hash would still be a stable per-PR identifier.
- **General agent capability.** We score decisions against realized outcomes on repositories we gate. That is
  not a capability benchmark and should not be read as one.

## 4. Trust tiers

Every record carries `trust.tier`, and is omitted rather than published at a tier it cannot support.

| Artifact | Tier | What you can check yourself |
|---|---|---|
| `EvalScoreRecord` | `reproducible` | Rehash the corpus; re-derive the score |
| Ledger checkpoint | `attested` | ECDSA against the published key, offline |
| Live-gate execution | *not verifiable* | Nothing — stated as such |

## 5. Governance of the scoring rules

A change to scoring gates through the same prospective-backtest machinery the gate's own thresholds use:
Pareto floor, visible **and** held-out split clearance, corpus checksums recorded per run.

The rule version rides on every record (`scoringRuleVersion`), so **a change is visible in the artifact** — a
validator diffing two records sees the version move, without depending on having read an announcement.

## 6. What a validator runs

One command. No credentials, no account, no coordination with us:

```bash
npx -p @loopover/mcp loopover-verify
```

It fetches the public surfaces, **recomputes** every commitment locally, and exits non-zero if any claim
fails. It never calls back to ask whether we passed — a deployment cannot pass by asserting that it passed.

Since #9724 we run it against ourselves nightly, from a runner holding no credentials of any kind, so the
tool is exercised against production continuously rather than only when someone thinks to look. If it is
failing, there is an open issue saying which claim broke.

**What a validator must trust:** our published signing key, and that the corpus we publish is the corpus we
scored. The second is exactly what `corpusChecksum` is for — and why the #9962 fix mattered.
