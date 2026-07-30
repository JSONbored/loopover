// Re-export of the engine's author-association vocabulary.
//
// The definition lives in @loopover/engine because the gate-advisory TWIN
// (packages/loopover-engine/src/advisory/gate-advisory.ts) needs it too, and the engine is a standalone
// published package that cannot import back out of src/. Same shape as settings/pr-type-label.ts, which
// re-exports its engine counterpart for exactly this reason.
export * from "../../packages/loopover-engine/src/settings/author-association";
