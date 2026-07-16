// linked-issue-hard-rules-config, converged onto @loopover/engine (#6203). This src/ file was a hand-maintained
// twin of the engine copy; it is now a thin re-export shim so the single implementation lives at
// packages/loopover-engine/src/review/linked-issue-hard-rules-config.ts (imported via relative source path, not
// the published package, to match this repo's existing engine-consumption convention — see
// src/settings/auto-close-exempt.ts).
export * from "../../packages/loopover-engine/src/review/linked-issue-hard-rules-config";
