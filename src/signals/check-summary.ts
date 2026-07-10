// Check-summary classifiers, extracted to `@jsonbored/gittensory-engine` (#4256) so reward-risk and the
// published gittensory-mcp/gittensory-miner CLIs can depend on the same source instead of reaching into
// `local-branch.ts` (which pulls in the whole review-scoring/Gittensor-API subsystem). This file is a thin
// re-export shim; the implementation lives at packages/gittensory-engine/src/signals/check-summary.ts
// (imported via relative source path, not the published package, to match this repo's existing
// engine-consumption convention — see e.g. src/signals/test-evidence.ts).
export * from "../../packages/gittensory-engine/src/signals/check-summary";
