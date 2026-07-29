// Remote server `branch` category (#9518, part 3).
//
// IMPORTANT ASYMMETRY, and the reason most of this file is output-only:
//
// Eleven of these thirteen tools take `localBranchAnalysisShape` or `variantsShape`, and BOTH embed
// `callerBranchEligibilitySchema` -- a zod `.transform()` that downgrades a caller-claimed
// "eligible" to "unknown" and forces `source: "user_supplied"`, so a caller can never assert its own
// eligibility into its own score. A transform is a runtime coercion; a shared contract's job is to
// describe the wire shape a caller may SEND, and the emitted JSON Schema would otherwise advertise
// the post-transform shape. Relocating those inputs would silently drop the downgrade -- the same
// trap `explain_score_breakdown` hit in this issue's review batch, caught there by typecheck.
//
// So: those eleven keep their INPUT server-side and migrate only their OUTPUT. The two tools whose
// inputs carry no transform (`preflight_local_diff`, `run_local_scorer`) migrate both halves.
//
// Placeholder `z.unknown()` fields stay `z.unknown()` -- see maintainer.ts's header for why
// blanket-converting them to a loose object is a real tightening, not a cleanup.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { PREFLIGHT_LIMITS } from "../limits.js";
import { PreflightPrInput, PreflightPrOutput } from "./preflight-pr.js";

/**
 * Changed-file metadata: paths plus line counts, never source content. Shared by the local-diff
 * preflight and the local scorer.
 *
 * Strict on purpose. This is the no-upload boundary in schema form -- a caller that adds `patch` or
 * `content` gets a rejected call, not a silently-stripped one, so it cannot believe it uploaded
 * source and be wrong about it.
 */
export const changedFileSchema = z.strictObject({
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
  binary: z.boolean().optional(),
});

/** One locally-executed validation command and its result. Strict for the same reason. */
export const validationEntrySchema = z.strictObject({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
  summary: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  exitCode: z.number().int().min(0).optional(),
});

// ── preflight local diff (input + output: no transform) ─────────────────────────────────────────

export const PreflightLocalDiffInput = PreflightPrInput.extend({
  // #9537: `cwd`/`baseRef` name a checkout only the stdio server can read; the remote server
  // ignores them. Widening the shared input is the safe direction.
  cwd: z.string().optional(),
  baseRef: z.string().optional(),
  changedLineCount: z.number().int().min(0).optional(),
  testFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  commitMessage: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
});
export const PreflightLocalDiffOutput = PreflightPrOutput.extend({
  localDiff: z.unknown().optional(),
});
export const preflightLocalDiffTool = defineTool({
  name: "loopover_preflight_local_diff",
  title: "Preflight local diff",
  description:
    "Preflight a real local git diff's METADATA (paths, line counts, test files, commit message -- never source content) against the repo's lane, duplicate, linked-issue and test-evidence signals, before anything is pushed.",
  category: "branch",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: PreflightLocalDiffInput,
  output: PreflightLocalDiffOutput,
});

// ── run local scorer (input + output: no transform) ─────────────────────────────────────────────

export const RunLocalScorerInput = z.object({
  changedFiles: z.array(changedFileSchema).min(1).max(500),
  validation: z.array(validationEntrySchema).max(50).optional(),
});
export const RunLocalScorerOutput = z.looseObject({
  tokenScores: z
    .looseObject({
      mode: z.string(),
      activeModel: z.string().optional(),
      sourceTokenScore: z.number().optional(),
      totalTokenScore: z.number().optional(),
      sourceLines: z.number().optional(),
      testTokenScore: z.number().optional(),
      nonCodeTokenScore: z.number().optional(),
      warnings: z.array(z.string()).optional(),
    })
    .optional(),
  usage: z.string().optional(),
});
export const runLocalScorerTool = defineTool({
  name: "loopover_run_local_scorer",
  title: "Run local scorer",
  description:
    "Compute deterministic token scores for a local change from changed-file METADATA and local validation results. Fully offline: no repo data, no network, no source content.",
  category: "branch",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: RunLocalScorerInput,
  output: RunLocalScorerOutput,
});

// ── output-only migrations (inputs stay server-side; see this file's header) ─────────────────────

/** Shared by the two variant-comparison tools. */
export const CompareVariantsOutput = z.looseObject({
  variants: z.array(z.unknown()).optional(),
});

export const PreviewLocalPrScoreOutput = z.looseObject({
  id: z.string().optional(),
  scoringModelSnapshotId: z.string().optional(),
  repoFullName: z.string().optional(),
  targetType: z.string().optional(),
  targetKey: z.string().optional(),
  contributorLogin: z.string().optional(),
  input: z.unknown().optional(),
  result: z.unknown().optional(),
  generatedAt: z.string().optional(),
});

export const PreflightCurrentBranchOutput = z.looseObject({
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  preflight: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
});

export const PreviewCurrentBranchScoreOutput = z.looseObject({
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  scorePreview: z.unknown().optional(),
  scenarioScorePreview: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
});

export const RankLocalNextActionsOutput = z.looseObject({
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  nextActions: z.array(z.unknown()).optional(),
  recommendedRerunCondition: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
});

export const ExplainLocalBlockersOutput = z.looseObject({
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  scoreBlockers: z.unknown().optional(),
  scenarioScorePreview: z.unknown().optional(),
  branchQualityBlockers: z.unknown().optional(),
  accountStateBlockers: z.unknown().optional(),
  recommendedRerunCondition: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
});

export const RemediationPlanOutput = z.looseObject({
  repoFullName: z.string().optional(),
  login: z.string().optional(),
  summary: z.string().optional(),
  recommendedRerunCondition: z.string().optional(),
  items: z.unknown().optional(),
});

export const PrepareLocalPrPacketOutput = z.looseObject({
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  prPacket: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
});

export const DraftPrBodyOutput = z.looseObject({
  repoFullName: z.string().optional(),
  title: z.string().optional(),
  sections: z.unknown().optional(),
  markdown: z.string().optional(),
  caveats: z.array(z.unknown()).optional(),
  excludedPrivateFields: z.array(z.unknown()).optional(),
  sourceUploadDisabled: z.boolean().optional(),
});

export const AgentRunBundleOutput = z.looseObject({
  run: z.unknown().optional(),
  actions: z.array(z.unknown()).optional(),
  contextSnapshots: z.array(z.unknown()).optional(),
  summary: z.unknown().optional(),
});
