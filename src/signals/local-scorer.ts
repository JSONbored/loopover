// #782 deterministic local scorer — extracted to `@jsonbored/gittensory-engine` (#4253) so the published
// gittensory-mcp / gittensory-miner CLIs and the hosted Worker import the identical, versioned scoring logic
// instead of drifting. The Vectorize/Node-coupled local-branch.ts is intentionally NOT moved; this shim only
// re-exports the pure scorer. packages/gittensory-engine/src/local-scorer.ts (imported via relative source
// path, matching the #2278/#2282/#4254 extraction shims) is the source of truth.
export { computeLocalScorerTokens } from "../../packages/gittensory-engine/src/local-scorer";
