// Remote server `review` category (#9518, part 2).
//
// Same relocation discipline as maintainer.ts: schemas move as-is from src/mcp/server.ts, so the
// advertised wire contract is unchanged. Placeholder `z.unknown()` fields stay `z.unknown()` --
// an earlier pass converted them to `z.looseObject({})` on the assumption that was an equivalent
// open shape, and mcp-output-schemas.test.ts immediately proved otherwise: explain_review_risk
// legitimately returns `roleContext: null`, which z.unknown() accepts and looseObject rejects (as
// it would an array). Deepening these into real modelled shapes is follow-on work that has to be
// driven by each handler's actual payload, not a blanket rewrite.
//
// Most of this category is METADATA-ONLY by design: the caller supplies changed-file paths and line
// counts from its own local diff scan, never patch or source text. The bounds below are what
// enforce that at the wire -- they are load-bearing, not decoration.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { ownerRepoPullInput } from "../shared.js";
import { PREFLIGHT_LIMITS } from "../limits.js";
import { PredictGateInput } from "./predict-gate.js";

/** Changed-file metadata as the slop/improvement surfaces accept it: path plus optional line
 *  counts. No content field exists by construction. */
const changedFileMetadataSchema = z.object({
  path: z.string().min(1).max(400),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
});

// ── explain gate disposition ────────────────────────────────────────────────────────────────────

/** Shares predict_gate's input: both run the same computePredictedGateVerdict path, one returning
 *  the verdict and one returning the per-rule reasoning behind it. */
export const ExplainGateDispositionInput = PredictGateInput;
export const ExplainGateDispositionOutput = z.looseObject({
  conclusion: z.string().optional(),
  pack: z.enum(["gittensor", "oss-anti-slop"]).optional(),
  dispositions: z
    .array(z.looseObject({ rule: z.string(), status: z.enum(["block", "advisory"]), reason: z.string() }))
    .optional(),
});
export const explainGateDispositionTool = defineTool({
  name: "loopover_explain_gate_disposition",
  title: "Explain gate disposition",
  description:
    "Explain, rule by rule, why the LoopOver gate would reach its predicted conclusion for a planned PR -- which rules block, which are advisory, and the reason for each. Shares predict_gate's metadata-only input and rate limit.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: ExplainGateDispositionInput,
  output: ExplainGateDispositionOutput,
});

// ── slop risk ───────────────────────────────────────────────────────────────────────────────────

export const CheckSlopRiskInput = z.object({
  changedFiles: z.array(changedFileMetadataSchema).max(2000),
  description: z.string().max(20000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
  commitMessages: z.array(z.string().max(2000)).max(200).optional(),
  hasLinkedIssue: z.boolean().optional(),
  issueDiscoveryLane: z.boolean().optional(),
});
export const CheckSlopRiskOutput = z.looseObject({
  slopRisk: z.number().optional(),
  band: z.enum(["clean", "low", "elevated", "high"]).optional(),
  findings: z.array(z.unknown()).optional(),
  rubric: z.string().optional(),
});
export const checkSlopRiskTool = defineTool({
  name: "loopover_check_slop_risk",
  title: "Check slop risk",
  description:
    "Score a planned change's slop risk from local diff METADATA only (paths + line counts, never source content): returns a 0-1 risk, a band, the specific findings behind it, and the rubric text. Pure computation -- no repo data, no secrets, no writes.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: CheckSlopRiskInput,
  output: CheckSlopRiskOutput,
});

// ── improvement potential ───────────────────────────────────────────────────────────────────────

export const CheckImprovementPotentialInput = z.object({
  changedFiles: z.array(changedFileMetadataSchema).max(2000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
  patchCoverageDeltaPercent: z.number().optional(),
  complexityDeltas: z
    .array(
      z.object({
        file: z.string().min(1).max(400),
        line: z.number().int().min(1),
        name: z.string().min(1).max(400),
        before: z.number().int().min(0),
        after: z.number().int().min(0),
        delta: z.number().int(),
      }),
    )
    .max(2000)
    .optional(),
  duplicationDeltas: z
    .array(
      z.object({
        file: z.string().min(1).max(400),
        line: z.number().int().min(1),
        duplicateOfLine: z.number().int().min(1),
        lines: z.number().int().min(1),
      }),
    )
    .max(2000)
    .optional(),
});
export const CheckImprovementPotentialOutput = z.looseObject({
  improvementScore: z.number().optional(),
  band: z.enum(["insufficient-signal", "none", "minor", "moderate", "significant"]).optional(),
  findings: z.array(z.unknown()).optional(),
});
export const checkImprovementPotentialTool = defineTool({
  name: "loopover_check_improvement_potential",
  title: "Check improvement potential",
  description:
    "Score how much a change actually improves the codebase from local METADATA only (coverage delta, complexity deltas, duplication deltas -- never source content): returns a score, a band, and the findings behind it. Pure computation; no repo data, no writes.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: CheckImprovementPotentialInput,
  output: CheckImprovementPotentialOutput,
});

// ── test evidence ───────────────────────────────────────────────────────────────────────────────

export const CheckTestEvidenceInput = z.object({
  changedPaths: z.array(z.string().min(1).max(400)).max(2000),
  testFiles: z.array(z.string().min(1).max(400)).max(2000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
});
export const CheckTestEvidenceOutput = z.looseObject({
  classification: z.enum(["strong", "adequate", "weak", "absent"]).optional(),
  changedFileCount: z.number().optional(),
  codeFileCount: z.number().optional(),
  testFileCount: z.number().optional(),
  guidance: z.array(z.string()).optional(),
});
export const checkTestEvidenceTool = defineTool({
  name: "loopover_check_test_evidence",
  title: "Check test evidence",
  description:
    "Classify how well a change's tests actually cover it, from changed PATHS and test names only: returns strong/adequate/weak/absent plus concrete guidance on what is missing. Metadata-only; no source content, no repo data, no writes.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: CheckTestEvidenceInput,
  output: CheckTestEvidenceOutput,
});

// ── issue slop ──────────────────────────────────────────────────────────────────────────────────

export const CheckIssueSlopInput = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(40000).optional(),
});
/** Deliberately the same shape as CheckSlopRiskOutput -- the server aliases the two
 *  (`checkIssueSlopOutputSchema = checkSlopRiskOutputSchema`) because both run the same rubric. */
export const CheckIssueSlopOutput = CheckSlopRiskOutput;
export const checkIssueSlopTool = defineTool({
  name: "loopover_check_issue_slop",
  title: "Check issue slop",
  description:
    "Score an issue's title and body for slop against the same rubric loopover_check_slop_risk applies to code changes: returns a risk, a band, and the findings behind it. Pure computation; no repo data, no writes.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: CheckIssueSlopInput,
  output: CheckIssueSlopOutput,
});

// ── boundary tests ──────────────────────────────────────────────────────────────────────────────

export const SuggestBoundaryTestsInput = z.object({
  // `.strict()` is the privacy boundary, not a nicety: it is what makes a caller-supplied
  // `patch`/content field a REJECTED call rather than a silently-stripped one, so an agent that
  // tries to upload source text learns it immediately instead of thinking it succeeded.
  changedFiles: z.array(z.strictObject({ path: z.string().min(1).max(400) })).max(500),
  boundaryTouches: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(400),
        kind: z.enum(["array_index_bounds", "null_or_undefined_branch", "empty_collection_check"]),
      }),
    )
    .max(20)
    .optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
});
export const SuggestBoundaryTestsOutput = z.looseObject({
  finding: z.unknown().optional(),
  spec: z.unknown().optional(),
});
export const suggestBoundaryTestsTool = defineTool({
  name: "loopover_suggest_boundary_tests",
  title: "Suggest boundary tests",
  description:
    "Suggest boundary-case test criteria for a change, from changed-file paths plus precomputed boundary-touch metadata the caller's own local diff scan produced. The remote boundary never accepts patch or source text. Advisory only -- returns criteria for the caller's own agent to scaffold from; never blocks or writes.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: SuggestBoundaryTestsInput,
  output: SuggestBoundaryTestsOutput,
});

// ── PR outcome ──────────────────────────────────────────────────────────────────────────────────

export const PrOutcomeInput = z.object({
  login: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
});
export const PrOutcomeOutput = z.looseObject({
  login: z.string().optional(),
  count: z.number().optional(),
  outcomes: z.array(z.unknown()).optional(),
});
export const prOutcomeTool = defineTool({
  name: "loopover_pr_outcome",
  title: "Get PR outcomes",
  description: "Return a contributor's recent pull-request outcomes (merged/closed and why), self-scoped to the authenticated login. Read-only.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: PrOutcomeInput,
  output: PrOutcomeOutput,
});

// ── PR AI review findings ───────────────────────────────────────────────────────────────────────

export const GetPrAiReviewFindingsInput = z.object({
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
});
export const GetPrAiReviewFindingsOutput = z.looseObject({
  status: z.enum(["ready", "not_found", "ai_review_off"]),
  repoFullName: z.string().optional(),
  pullNumber: z.number().optional(),
  login: z.string().optional(),
  headSha: z.string().nullable().optional(),
  findings: z
    .array(
      z.looseObject({
        category: z.string(),
        path: z.string(),
        severity: z.enum(["blocker", "nit"]),
        line: z.number(),
        body: z.string(),
      }),
    )
    .optional(),
  categoryCounts: z.record(z.string(), z.number()).optional(),
});
export const getPrAiReviewFindingsTool = defineTool({
  name: "loopover_get_pr_ai_review_findings",
  title: "Get PR AI review findings",
  description:
    "Return the AI reviewer's own findings for one of the caller's OWN pull requests (category, path, severity, line, body), so a contributor can act on them without scraping the PR comment. Self-scoped: the caller must own the PR. Read-only.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: GetPrAiReviewFindingsInput,
  output: GetPrAiReviewFindingsOutput,
});

// ── PR maintainer packet ────────────────────────────────────────────────────────────────────────

export const GetPrMaintainerPacketInput = ownerRepoPullInput;
export const GetPrMaintainerPacketOutput = z.looseObject({
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  generatedAt: z.string().optional(),
  report: z.unknown().optional(),
});
export const getPrMaintainerPacketTool = defineTool({
  name: "loopover_get_pr_maintainer_packet",
  title: "Get PR maintainer packet",
  description:
    "Return the full maintainer packet for an open PR: triage context assembled from cached repo/PR/issue/review/check metadata, wrapped with data-quality. Metadata-only, repo-scoped, no GitHub writes.",
  category: "review",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetPrMaintainerPacketInput,
  output: GetPrMaintainerPacketOutput,
});

// ── lint PR text ────────────────────────────────────────────────────────────────────────────────

export const LintPrTextInput = z.object({
  commitMessages: z.array(z.string().max(PREFLIGHT_LIMITS.bodyChars)).max(50).optional(),
  prBody: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  linkedIssue: z.number().int().positive().optional(),
});
export const LintPrTextOutput = z.looseObject({
  verdict: z.string().optional(),
  score: z.number().optional(),
  components: z.unknown().optional(),
  fixes: z.array(z.unknown()).optional(),
  summary: z.string().optional(),
  generatedAt: z.string().optional(),
});
export const lintPrTextTool = defineTool({
  name: "loopover_lint_pr_text",
  title: "Lint PR text",
  description:
    "Lint a PR's commit messages and body for Conventional Commit form, traceability, and substance: returns a verdict, a score, per-component breakdown, and concrete fixes. Pure text computation; no repo data, no writes.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: LintPrTextInput,
  output: LintPrTextOutput,
});

// ── explain score breakdown ─────────────────────────────────────────────────────────────────────

const linkedIssueContextSchema = z.object({
  status: z.enum(["raw", "plausible", "validated", "invalid", "unavailable"]).optional(),
  source: z.enum(["user_supplied", "official_mirror", "github_cache", "issue_quality", "missing"]).optional(),
  issueNumbers: z.array(z.number().int().positive()).max(50).optional(),
  solvedByPullRequests: z.array(z.number().int().positive()).max(50).optional(),
  reason: z.string().optional(),
  warnings: z.array(z.string()).max(20).optional(),
});

/**
 * Caller-asserted branch eligibility.
 *
 * The server wraps this in a `.transform()` that downgrades a caller-claimed "eligible" to
 * "unknown" and forces `source: "user_supplied"` -- a caller cannot assert its own eligibility into
 * the score. That transform stays in the SERVER's schema, deliberately not relocated here: a
 * transform is a runtime coercion, and putting it in the shared contract would make the advertised
 * JSON Schema describe the post-transform shape rather than what a caller may actually send.
 */
const callerBranchEligibilitySchema = z.object({
  status: z.enum(["eligible", "ineligible", "unknown"]),
  source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
  reason: z.string().optional(),
  checkedAt: z.string().optional(),
  stale: z.boolean().optional(),
});

export const ExplainScoreBreakdownInput = z.object({
  repoFullName: z.string().min(3),
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("local_diff"),
  targetKey: z.string().optional(),
  contributorLogin: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  linkedIssueContext: linkedIssueContextSchema.optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  testTokenScore: z.number().min(0).optional(),
  nonCodeTokenScore: z.number().min(0).optional(),
  existingContributorTokenScore: z.number().min(0).optional(),
  prAgeHours: z.number().min(0).optional(),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  duplicateRiskCount: z.number().int().min(0).optional(),
  metadataOnly: z.boolean().default(true),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  branchEligibility: callerBranchEligibilitySchema.optional(),
});
export const ExplainScoreBreakdownOutput = z.looseObject({
  repoFullName: z.string().optional(),
  scoreabilityStatus: z.string().optional(),
  effectiveEstimatedScore: z.number().optional(),
  components: z.unknown().optional(),
  gateHighlights: z.unknown().optional(),
  highestLeverageLever: z.unknown().optional(),
});
export const explainScoreBreakdownTool = defineTool({
  name: "loopover_explain_score_breakdown",
  title: "Explain score breakdown",
  description:
    "Explain how a change's private score is composed: per-component contributions, the gate highlights that matter, and the single highest-leverage lever to improve it. Metadata-only inputs; self-scoped.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: ExplainScoreBreakdownInput,
  output: ExplainScoreBreakdownOutput,
});

// ── explain review risk ─────────────────────────────────────────────────────────────────────────

export const ExplainReviewRiskInput = z.object({
  repoFullName: z.string().min(3).max(PREFLIGHT_LIMITS.repoFullNameChars),
  contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(PREFLIGHT_LIMITS.linkedIssues).optional(),
  tests: z.array(z.string().max(PREFLIGHT_LIMITS.testChars)).max(PREFLIGHT_LIMITS.tests).optional(),
  authorAssociation: z.string().max(PREFLIGHT_LIMITS.authorAssociationChars).optional(),
});
export const ExplainReviewRiskOutput = z.looseObject({
  preflight: z.unknown().optional(),
  roleContext: z.unknown().optional(),
  recommendation: z.string().optional(),
});
export const explainReviewRiskTool = defineTool({
  name: "loopover_explain_review_risk",
  title: "Explain review risk",
  description:
    "Explain the review risk a planned PR carries: the preflight signals against it, the author's role context, and a single recommendation. Metadata-only, advisory.",
  category: "review",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: ExplainReviewRiskInput,
  output: ExplainReviewRiskOutput,
});
