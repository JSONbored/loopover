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

The old vendor/embed plan is obsolete. The review system now lives in **gittensory-native codepaths** guarded by `GITTENSORY_REVIEW_*` flags. There is no `REVIEWBOT_ENGINE_ENABLED` path in this repository.

## Current architecture

- **Single project:** gittensory is the only source repo for the converged review system.
- **Native port:** review features live under `src/review/**`, `src/queue/processors.ts`, and related first-party modules.
- **Public comment path:** the unified in-place PR comment is driven by the native bridge and the `GITTENSORY_REVIEW_UNIFIED_COMMENT` flag.
- **Infra model:** D1 / Queue / AI / optional Vectorize / optional R2 / optional Browser bindings are declared directly in gittensory.
- **Config model:** rollout is controlled by `GITTENSORY_REVIEW_*` flags plus the per-repo allowlist `GITTENSORY_REVIEW_REPOS`.
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

- `GITTENSORY_REVIEW_UNIFIED_COMMENT` — single public PR comment
- `GITTENSORY_REVIEW_SAFETY` — prompt-injection defang + secret scan
- `GITTENSORY_REVIEW_GROUNDING` — CI + full-file grounding
- `GITTENSORY_REVIEW_RAG` — retrieval-augmented context
- `GITTENSORY_REVIEW_REPUTATION` — internal spend gate
- `GITTENSORY_REVIEW_OPS` — operator stats / anomaly surfaces
- `GITTENSORY_REVIEW_SELFTUNE` — tightening-only self-tuning loop
- `GITTENSORY_REVIEW_PARITY_AUDIT` — shadow parity recording
- `GITTENSORY_REVIEW_REPOS` — per-repo cutover allowlist

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

Method: enumerated the account's Cloudflare resources (Workers, D1, KV, R2, Hyperdrive) via the
Cloudflare API, then cross-referenced each `gittensory-*`/`reviewbot-*` resource against
`wrangler.jsonc`'s declared bindings and a `grep` of `src/` for actual runtime references. The
account also hosts unrelated projects (metagraphed, transmogrifi, heyclaude, aethereal-dev,
claudepro, homelab) — those are out of scope and omitted below.

Inventory snapshot taken 2026-07-04 with read-only Cloudflare API listing calls (Workers, D1, KV,
R2, Hyperdrive); no object/bucket contents were read.

| Resource | Type | Purpose | Usage evidence | Data sensitivity | Recommended action |
|---|---|---|---|---|---|
| `gittensory-api` | Worker | The live production API Worker — public API, GitHub webhook receiver, Orb broker/relay endpoints, homepage public-stats endpoint. Auto-deploys on push to `main` via Cloudflare Workers Builds. | `wrangler.jsonc` (this repo) is its config; deployed and actively serving via the custom domain route declared in `wrangler.jsonc:150-155`. | None directly (routes/vars only); auth/webhook secrets are Worker secrets, not in this repo. | **keep** — this is the hosted path itself. |
| `gittensory` (D1) | D1 database | Primary datastore: pull requests, review/audit ledger, repository settings, public-stats aggregates, installation/auth state. | Bound as `DB` in `wrangler.jsonc:156-163`; read/written throughout `src/` (e.g. `src/server.ts`, `src/review/**`, `src/github/**`). 111 migrations under `migrations/`. | Contains repo/installation metadata and review history; no sensitive financial or operator-control data is stored in D1. | **keep** — actively used by the hosted Worker; self-host uses its own Postgres/SQLite instead (`src/selfhost/**`), this D1 instance is the hosted deployment's live store. |
| `RATE_LIMITER` (Durable Object, in `gittensory-api`) | Durable Object | Request-rate limiting (webhook/API abuse guard). | Bound in `wrangler.jsonc:168-175,176-181`; used in `src/auth/rate-limit.ts`, `src/server.ts`. | None. | **keep** — actively used. |
| `gittensory-jobs` / `gittensory-jobs-dlq` | Queues | API/broker maintenance job lane (sweeps, backfills) + its dead-letter queue. | Bound as `JOBS` producer/consumer in `wrangler.jsonc:182-220`; consumed in `src/queue/**`. | None. | **keep** — actively used by the hosted Worker. Note: heavy review-*execution* jobs route through the self-host Redis-backed queue instead (`src/selfhost/**`); this Cloudflare queue is the maintenance lane only (see the binding's own comment, `wrangler.jsonc:191-192`). |
| `gittensory-review-audit` (R2) | R2 bucket | Historical: stored AI-review visual before/after screenshot captures (`REVIEW_AUDIT` binding) from when review execution ran in the Cloudflare Worker. | **No `r2_buckets` block exists in `wrangler.jsonc` today.** `git log -p -- wrangler.jsonc` shows an `r2_buckets`/`REVIEW_AUDIT` binding was added in `009bfe3e` (convergence infra) and later removed (squashed into `2572de51`, self-host cutover) once review execution moved off the Cloudflare Worker. `src/env.d.ts:20-22` and `src/review/visual/{shot,capture}.ts` still type `env.REVIEW_AUDIT?: R2Bucket` as an **optional** interface — self-host injects a filesystem-backed equivalent (`src/selfhost/blob-store.ts`) via `REVIEW_AUDIT_DIR`; the deployed Cloudflare Worker binds nothing here anymore. | May contain historical PR-diff screenshots (web-visible file changes only, not source/secrets) from the pre-cutover period. | **unknown — needs owner decision.** The bucket is real, unbound, and holds whatever it accumulated before the cutover. Not provably safe to delete without confirming (a) nothing outside this repo still reads it directly via the R2 API/dashboard, and (b) whether its contents have any retention/audit value. Flagging for a dedicated retire-later follow-up, not acting here. |
| `reviewbot-audit` (R2) | R2 bucket | Predecessor of `gittensory-review-audit` from the pre-convergence `reviewbot` project (see `CONVERGENCE_RUNBOOK.md` above — reviewbot was a separate repo/Worker that converged into gittensory in `#1036`/`3c4a30b0`). | **Zero references** to `reviewbot-audit` (or any `reviewbot` bucket/binding) anywhere in `src/`, `wrangler.jsonc`, or scripts — confirmed by repo-wide grep. The only surviving `reviewbot` mentions are code comments documenting the native-port lineage (e.g. `src/review/parity.ts`, `src/review/alerts.ts`), not live bindings. | Same class as above: historical visual-capture data from the pre-convergence reviewbot Worker, if any was ever written. | **retire-later, needs owner decision.** This looks like the strongest orphan candidate in the account (older, unreferenced by name anywhere, and its owning Worker/repo no longer exists per the convergence runbook above) — but bucket contents were not inspected (no destructive or even read action taken here), so final deletion still needs explicit maintainer sign-off and a follow-up issue, per `#1826`'s own acceptance criteria. |
| Workers AI (`AI` / `AI_EMBED` binding) | Platform capability (no standalone resource to enumerate) | Historical: hosted free-tier AI review calls and embeddings via Cloudflare's `AI` binding, routed through AI Gateway (`AI_GATEWAY_ID`). | **No `ai` block exists in `wrangler.jsonc` today** — added in `d9541cdc` (Workers AI summaries), re-declared through the RAG convergence work, then removed (squashed into `2572de51`, self-host cutover). `src/env.d.ts:8,13,55-57` still type `AI?`/`AI_EMBED?: Ai` as optional interfaces for backward-compat code paths; the deployed Worker (`AI_PROVIDER=codex` in live production, per current ground truth) never sets this binding. | None (no data at rest — this is an API capability, not a resource with contents). | **keep code as-is / no action** — this isn't a resource that can be "orphaned" in the storage sense; it's a removed binding whose optional-interface type stuck around intentionally for self-host's own `AI`-shaped adapters (e.g. Ollama). Nothing to retire. |
| Browser Rendering (`BROWSER` binding) | Platform capability (no standalone resource to enumerate) | Historical: rendered before/after visual screenshots of web-visible PR diffs via Cloudflare Browser Rendering, paired with the `REVIEW_AUDIT` R2 bucket above. | Same add (`009bfe3e`) / remove (`2572de51`) history as `REVIEW_AUDIT`. `src/env.d.ts:23-25` still types `BROWSER?: Fetcher` as optional; self-host's equivalent is `BROWSER_WS_ENDPOINT` (`src/review/visual/shot.ts`, `src/selfhost/stubs/puppeteer.ts`). No binding in current `wrangler.jsonc`. | None (capability, not a data resource). | **keep code as-is / no action** — same reasoning as Workers AI above. |
| `REVIEW_CONFIG` (KV) — **already gone** | KV namespace (historical, id `aed9890dbd3f4f73bf46b43d7d0478d7` per its own removed `wrangler.jsonc` comment) | Historical: reviewbot-era per-repo config (keyed by repo slug), read by the converged auto-maintain path for `hardGuardrailGlobs` before `.gittensory.yml` config-as-code existed. Its own removal comment noted it "survives reviewbot's decommission," i.e. it long predates this repo's convergence. | Binding removed from `wrangler.jsonc` in the same self-host cutover (`2572de51`) as `REVIEW_AUDIT`/`VECTORIZE`/`BROWSER`/`AI`; `hardGuardrailGlobs` now lives in `.gittensory.yml`/D1 settings (`src/settings/agent-actions.ts`, `src/signals/change-guardrail.ts`) with zero KV involvement. **The current account-wide `kv_namespaces_list` (2 namespaces total: `heyclaude-mcp-cache-prod`, `METAGRAPH_CONTROL`) contains neither this id nor any gittensory-named namespace** — the Cloudflare-side resource itself appears to have already been deleted, not merely unbound. | N/A (resource no longer exists to classify). | **no action needed** — nothing left to retire; noted here only for the historical record since `#1826` asked for reviewbot-era resources to be traced. |
| Hyperdrive | — | N/A | The account has 3 Hyperdrive configs; all are `heyclaude-*`/`metagraphed-*`. `wrangler.jsonc` declares no `hyperdrive` block. | N/A | **not applicable** — gittensory never had this resource type; nothing to inventory. |

### wrangler.jsonc binding hygiene

Every binding currently declared in `wrangler.jsonc` (`DB`, `RATE_LIMITER`, `JOBS`/`gittensory-jobs-dlq`)
has a live, provable code reference in `src/` — **no dead bindings were found**, so no binding
declarations were removed in this pass. The optional `AI`, `AI_EMBED`, `VECTORIZE`, `REVIEW_AUDIT`,
`BROWSER`, and `WEBHOOKS` entries in `src/env.d.ts` are deliberately-kept interfaces for self-host
adapters (see each field's own comment) — they are not stale, so they were left as-is.

### What this pass did NOT do

- Did not read, list objects in, or otherwise touch the contents of `gittensory-review-audit` or
  `reviewbot-audit`.
- Did not delete, disable, rename, or modify any Cloudflare-side resource.
- Did not produce row-count/checksum migration verification (no data is moving in this pass — this
  is classification only, per `#1826`'s scope). That remains open work for whichever follow-up issue
  acts on the `retire-later`/`unknown` rows above.
- Did not resolve the parent roadmap `#1819`'s other child issues (backup/restore, release
  packaging, Sentry context, Orb telemetry, runner load, resource profiling, docs audit) — this
  section only covers the `#1826` inventory slice.
