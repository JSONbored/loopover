// pr-type-label, converged onto @loopover/engine (#4879, extended by #6194). This src/ file was a hand-maintained twin
// of the engine copy; it is now a thin re-export shim so the single implementation lives at
// packages/loopover-engine/src/settings/pr-type-label.ts (imported via relative source path, not the published package,
// to match this repo's existing engine-consumption convention — see src/signals/check-summary.ts).
export * from "../../packages/loopover-engine/src/settings/pr-type-label";
