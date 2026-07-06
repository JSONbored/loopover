// Deterministic score-preview builder, extracted to `@jsonbored/gittensory-engine` (#2282) so the miner can
// run the same preview locally. This file is a thin re-export shim; the implementation lives at
// packages/gittensory-engine/src/scoring/preview.ts (imported via relative source path, not the published
// package, to match this repo's existing engine-consumption convention — see e.g.
// test/unit/ai-policy-map.test.ts — and to avoid depending on the engine package's built `dist/` output,
// which is not guaranteed to exist yet when `typecheck`/`test:coverage` run in CI).
export * from "../../packages/gittensory-engine/src/scoring/preview";
