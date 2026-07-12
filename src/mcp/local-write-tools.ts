// #780 miner write-tools. MOVED to packages/gittensory-engine/src/miner/local-write-tools.ts (#2337): this
// module was always pure/deterministic with no root-specific dependency, so it now lives in the shared "brain"
// layer alongside the rest of the portable engine — the same functions packages/gittensory-miner's own real
// driving-loop entrypoint imports directly (zero network round-trip, zero duplicated/drifting logic) to
// construct the exact command this MCP server's own gittensory_open_pr (and sibling) tools return. This file is
// now a thin re-export preserving every existing import path (src/mcp/server.ts, src/review/fix-handoff-
// render.ts, src/miner/soft-claim.ts, test/unit/local-write-tools.test.ts) unchanged.
export {
  LOCAL_WRITE_BOUNDARY,
  buildApplyLabelsSpec,
  buildClosePrSpec,
  buildCreateBranchSpec,
  buildDeleteBranchSpec,
  buildFileIssueSpec,
  buildFollowUpIssueSpec,
  buildOpenPrSpec,
  buildPostEligibilityCommentSpec,
  buildTestGenSpec,
  type LocalWriteActionSpec,
  type LocalWriteJsonValue,
} from "@jsonbored/gittensory-engine";
