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
