// Pure, deterministic path matchers for slop classification (#561), extracted to
// `@jsonbored/gittensory-engine` (#4252) so the published gittensory-mcp/gittensory-miner CLIs can depend on
// the same source instead of hand-porting it. This file is a thin re-export shim; the implementation lives at
// packages/gittensory-engine/src/signals/path-matchers.ts (imported via relative source path, not the
// published package, to match this repo's existing engine-consumption convention — see e.g.
// src/signals/test-evidence.ts — and to avoid depending on the engine package's built `dist/` output, which
// is not guaranteed to exist yet when `typecheck`/`test:coverage` run in CI).
//
// MUST NOT import from local-branch.ts (#3690-followup): this file is reachable from
// apps/gittensory-ui/src/lib/registration-workspace.ts via focus-manifest.ts, and local-branch.ts pulls in
// the whole review-scoring/Gittensor-API subsystem, which breaks `ui:typecheck` under the UI's tsconfig (no
// Workers ambient types there).
export * from "../../packages/gittensory-engine/src/signals/path-matchers";
