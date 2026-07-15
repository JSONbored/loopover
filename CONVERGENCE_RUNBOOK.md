# Convergence runbook (native-port model)

## Purpose

This runbook records the **post-port** operating model for the reviewbot → gittensory convergence tracked by:

- `#983` — parent convergence / migration tracker
- `#1029` — self-host / packaging layer
- `#976` — portable runtime
- `#977` — storage + infrastructure adapters
- `#978` — pluggable AI backend
- `#979` — subscription-backed AI providers
- `#980` — Docker / compose self-host
- `#981` — configuration, secrets, onboarding
- `#982` — dashboard / observability
- `#1030` — decommission legacy reviewbot identity + repo, keep gittensory as the single project

The old vendor/embed plan is obsolete. The review system now lives in **gittensory-native codepaths** guarded by `LOOPOVER_REVIEW_*` flags. There is no `REVIEWBOT_ENGINE_ENABLED` path in this repository.

## Current architecture

- **Single project:** gittensory is the only source repo for the converged review system.
- **Native port:** review features live under `src/review/**`, `src/queue/processors.ts`, and related first-party modules.
- **Public comment path:** the unified in-place PR comment is rendered unconditionally by the native bridge — it is the only comment-rendering path (the legacy multi-panel renderer and its `LOOPOVER_REVIEW_UNIFIED_COMMENT` flag were retired).
- **Infra model:** D1 / Queue / AI / optional Vectorize / optional R2 / optional Browser bindings are declared directly in gittensory.
- **Config model:** rollout is controlled by `LOOPOVER_REVIEW_*` flags plus the per-repo allowlist `LOOPOVER_REVIEW_REPOS`.
- **Parity model:** parity is measured as a shadow/deploy-time comparison against authoritative legacy audit rows; local checkout validation proves structure and safety, not historical decision identity.

## What issue `#1030` means in this repo

For this repository, the relevant definition of done is:

- remove stale documentation that still assumes a separate reviewbot repo or vendored engine path
- keep only the native-port rollout model in docs and code
- preserve the parity / audit evidence model before any external deletion work
- document the manual decommission steps that happen outside this checkout

The following are **not** actions a source-code patch can perform by itself:

- deleting a separate GitHub repository
- deleting a deployed Cloudflare Worker
- removing GitHub secrets, app installs, KV/R2/Vectorize resources, or other hosted bindings
- minimizing or editing already-posted historical GitHub comments

Those are operator actions. This repo should document them clearly and avoid implying they happen automatically.

## Native review controls

Primary native review flags and surfaces:

- `LOOPOVER_REVIEW_SAFETY` — prompt-injection defang + secret scan
- `LOOPOVER_REVIEW_GROUNDING` — CI + full-file grounding
- `LOOPOVER_REVIEW_RAG` — retrieval-augmented context
- `LOOPOVER_REVIEW_REPUTATION` — internal spend gate
- `LOOPOVER_REVIEW_OPS` — operator stats / anomaly surfaces
- `LOOPOVER_REVIEW_SELFTUNE` — tightening-only self-tuning loop
- `LOOPOVER_REVIEW_PARITY_AUDIT` — shadow parity recording
- `LOOPOVER_REVIEW_REPOS` — per-repo cutover allowlist

These replace the old notion of a separate reviewbot engine toggle.

## External decommission checklist

Run these only after parity evidence is preserved and the native gittensory path is holding:

1. **Preserve evidence first**
   - export or snapshot the authoritative audit / parity evidence needed for rollback and analytics
   - retain source tags so native-vs-legacy comparisons remain explainable after shutdown

2. **Retire legacy identity**
   - stop new `reviewwed[bot]` check-runs / comments
   - minimize or otherwise close out legacy public comment surfaces where appropriate

3. **Delete legacy runtime**
   - disable deployment for the legacy Worker
   - remove its CI workflow, secrets, runtime bindings, and GitHub App wiring if they still exist

4. **Archive, then delete the legacy repo**
   - archive first for a short confirmation window
   - delete only after native gittensory behavior is validated and rollback is no longer required

5. **Do not couple deletion to public-OSS expansion**
   - the “hide how it works” design remains a separate gate
   - deleting the legacy repo must not force publication of gameable internals

## Local validation expectations

Local validation for the converged repo should prove:

- native review codepaths compile
- unit / worker tests cover the converged review surfaces
- unified comment rendering works under the native flags
- parity recording is fail-safe and record-only

Local validation cannot prove:

- live GitHub App permission state
- live Cloudflare binding state
- historical parity against a deleted hosted system

## Validation commands

Use these from the repo root:

```sh
npm ci
npm run typecheck
npm run test:unit
npm run test:workers
```

Use broader CI validation when needed:

```sh
npm run test:ci
```

## Repository status after convergence

- gittensory owns the converged implementation
- docs must describe the native-port model only
- legacy decommission is an operator checklist, not an implicit code path
- the public-OSS flip remains separately gated

## Hosted Cloudflare resource inventory (#1826)

Tracked by `#1826` (child of the self-host production-readiness roadmap `#1819`). This is
**inventory and classification only** — nothing in this section authorizes deleting or disabling a
live Cloudflare resource. Any `retire-later` row below needs its own follow-up issue and explicit
maintainer approval before action.

Inventory snapshot taken 2026-07-04 with read-only Cloudflare listing calls, then cross-referenced
against `wrangler.jsonc` and repo-local runtime references. The public runbook intentionally records
resource classes and actions without account-wide project names, concrete Cloudflare resource names,
provider selections, namespace ids, or orphan storage identifiers. Keep exact inventory output in the
private operator handoff for #1826 instead of committing it here.

| Resource class | Type | Purpose | Usage evidence | Data sensitivity | Recommended action |
|---|---|---|---|---|---|
| Hosted API Worker | Worker | Public API, GitHub webhook receiver, broker/relay endpoints, and homepage public-stats endpoint for the hosted deployment. | `wrangler.jsonc` is this repo's deployment config; route, variable, and binding declarations are reviewed there. | None directly in config; auth and webhook material are Worker secrets, not repo contents. | **keep** — this is the hosted path itself. |
| Hosted relational datastore | D1 database | Primary hosted datastore for application state and public aggregate data. | Bound as `DB` in `wrangler.jsonc`; read and written by the server, review, and GitHub integration paths under `src/`. | Contains repository, installation, settings, and review-history metadata. | **keep** — actively used by the hosted Worker; self-host deployments use their own datastore path. |
| Rate-limit object | Durable Object | Request-rate limiting for webhook/API abuse protection. | Bound in `wrangler.jsonc` and used by the rate-limit middleware and server routes. | None. | **keep** — actively used. |
| Maintenance queues | Queues | Hosted API/broker maintenance job lane and dead-letter queue. | Producer and consumer bindings are declared in `wrangler.jsonc`; queue consumers live under `src/queue/**`. | None. | **keep** — actively used by the hosted Worker for maintenance jobs. |
| Historical visual-audit storage | R2 buckets | Historical screenshot/audit capture storage from earlier Cloudflare-hosted review execution. | No current `r2_buckets` block exists in `wrangler.jsonc`; remaining interfaces are optional compatibility hooks for self-host blob storage. | May contain historical review artifacts; contents were not read or listed during this inventory. | **retire-later / needs owner decision** — confirm retention value and out-of-repo consumers in a private operator follow-up before deletion. |
| Removed platform capabilities | Workers AI / Browser Rendering | Historical hosted review and visual-capture capabilities. | No current binding blocks exist in `wrangler.jsonc`; optional TypeScript interfaces remain for compatibility adapters. | None at rest in this repo. | **keep code as-is / no action** — these are removed capabilities, not storage resources to retire from this public runbook. |
| Historical config namespace | KV namespace | Historical per-repo configuration storage predating config-as-code. | No current KV binding remains in `wrangler.jsonc`; current configuration flows use repo config and database-backed settings. | N/A in this public runbook. | **no action needed here** — exact namespace identifiers and account-listing evidence belong in the private operator handoff if needed. |
| Other account resource classes | Hyperdrive / unrelated projects | Out of scope for gittensory cleanup. | `wrangler.jsonc` declares no binding for these resource classes. | N/A. | **not applicable** — do not enumerate unrelated account resources in this repo. |

### wrangler.jsonc binding hygiene

Every binding currently declared in `wrangler.jsonc` has a live, provable code reference in
`src/` — **no dead bindings were found**, so no binding declarations were removed in this pass. The
optional compatibility entries in `src/env.d.ts` are deliberately-kept interfaces for self-host
adapters (see each field's own comment) — they are not stale, so they were left as-is.

### What this pass did NOT do

- Did not read, list objects in, or otherwise touch the contents of any historical visual-audit
  storage buckets.
- Did not delete, disable, rename, or modify any Cloudflare-side resource.
- Did not produce row-count/checksum migration verification (no data is moving in this pass — this
  is classification only, per `#1826`'s scope). That remains open work for whichever follow-up issue
  acts on the `retire-later`/`unknown` rows above.
- Did not resolve the parent roadmap `#1819`'s other child issues (backup/restore, release
  packaging, Sentry context, Orb telemetry, runner load, resource profiling, docs audit) — this
  section only covers the `#1826` inventory slice.
