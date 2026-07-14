// Loop results-delivery composer (#4801) — thin re-export shim. The canonical implementation lives in
// `@loopover/engine` (packages/loopover-engine/src/results-payload.ts), imported via the relative source
// path (matching src/idea-intake.ts / src/signals/slop.ts) so the published loopover-mcp / loopover-miner
// CLIs share one composer, and so this never depends on the engine's built dist/ during typecheck/test.
export * from "../packages/loopover-engine/src/results-payload";
