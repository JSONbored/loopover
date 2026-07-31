// The stdio server's local-git family, plus the last few remote tools whose inputs had nowhere to
// live until now (#9537).
//
// WHY THESE ARRIVE LAST. Every tool here exists on the stdio server, and thirteen of them also
// exist on the remote one -- with a DIFFERENT input schema on each side. #9518 could migrate only
// the outputs for those, because picking one of two hand-mirrored inputs is a wire decision, not a
// relocation. This file makes that decision once, and the rule it follows is:
//
//   **The contract describes what a caller may SEND. A runtime coercion applied after validation is
//   a server-side control and stays server-side.**
//
// That resolves the `callerBranchEligibilitySchema` problem #9518 documented rather than solving.
// The remote server wraps caller-claimed branch eligibility in a `.transform()` that downgrades an
// asserted "eligible" to "unknown" -- so a caller cannot assert its own eligibility into its own
// score. Relocating THAT would have advertised the post-transform shape. Relocating the shape a
// caller actually sends (which is what the stdio server has always advertised) is correct on both
// servers, and the remote keeps applying its downgrade to the parsed result exactly as before.
//
// Where the two hand-mirrored copies disagreed on BOUNDS, the contract takes the wider -- narrowing
// would start rejecting input one of the two servers accepts today. Where they disagreed on whether
// `login` is required, it takes the stdio server's `optional`: that server resolves the login from
// its own authenticated session, and the remote server resolves it from the identity it was
// constructed with, so requiring the caller to restate it was always redundant.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { PREFLIGHT_LIMITS, SCENARIO_LIMITS, SCENARIO_MAX_LINKED_ISSUE_NUMBERS } from "../limits.js";
import { FEASIBILITY_VERDICTS } from "../enums.js";
import {
  AgentRunBundleOutput,
  CompareVariantsOutput,
  DraftPrBodyOutput,
  ExplainLocalBlockersOutput,
  PreflightCurrentBranchOutput,
  PrepareLocalPrPacketOutput,
  PreviewCurrentBranchScoreOutput,
  PreviewLocalPrScoreOutput,
  RankLocalNextActionsOutput,
  RemediationPlanOutput,
} from "./branch.js";
import {
  FindOpportunitiesOutput,
  GetEligibilityPlanOutput,
  MarkNotificationsReadOutput,
  RetrieveIssueContextOutput,
  SimulateOpenPrPressureOutput,
  WatchIssuesOutput,
} from "./discovery-utility.js";
import { callerBranchEligibilitySchema } from "./review.js";
import { changedFileSchema, validationEntrySchema } from "./branch.js";
import { focusManifestInputSchema } from "../api-requests.js";

/** One locally-executed validation command and its result, as the local-branch surfaces accept it. */
const localValidationEntry = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
  summary: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  exitCode: z.number().int().min(0).optional(),
});

// ── the current-branch family ───────────────────────────────────────────────────────────────────

/**
 * What every "look at the branch I am on" tool takes.
 *
 * `login` is optional because both servers resolve it themselves -- the stdio server from its
 * persisted session (or `LOOPOVER_LOGIN`), the remote server from the identity it authenticated.
 * `cwd` is what makes this family `local-git`: it names a checkout only the caller's machine has.
 */
export const CurrentBranchInput = z.object({
  // Bounds match LocalBranchAnalysisInput on shared fields so a stdio override that serves this
  // shape (e.g. StdioCompareLocalVariantsInput) is a true narrowing under checkInputNarrowing (#10041),
  // not a silent loosening of maxLength / maxItems the wider contract already publishes.
  login: z.string().min(1).max(SCENARIO_LIMITS.branchRefChars).optional(),
  cwd: z.string().optional(),
  repoFullName: z.string().min(3).max(SCENARIO_LIMITS.repoFullNameChars).optional(),
  baseRef: z.string().max(SCENARIO_LIMITS.branchRefChars).optional(),
  headRef: z.string().max(SCENARIO_LIMITS.branchRefChars).optional(),
  branchName: z.string().max(SCENARIO_LIMITS.branchRefChars).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(SCENARIO_MAX_LINKED_ISSUE_NUMBERS).optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  branchEligibility: callerBranchEligibilitySchema.optional(),
  validation: z.array(localValidationEntry).max(50).optional(),
  scorePreviewCommand: z.string().optional(),
});

/**
 * The FULL current-branch vocabulary: everything a caller may supply about a branch (#9662).
 *
 * Previously this lived as a 40-line `localBranchAnalysisShape` literal inside `src/mcp/server.ts` -- the
 * hand-written kind of declaration this package exists to remove -- and the ten tools below advertised a
 * strictly NARROWER `CurrentBranchInput` in the registry. So `listToolDefinitions()`, and with it the
 * OpenAI/Anthropic spec builders and the `.well-known` catalogs, described a tool that rejected eight
 * fields the remote server accepts, and nothing could see the gap.
 *
 * The contract is the wider surface, per the rule a server narrows FROM: the remote accepts this whole
 * shape because a caller may supply the metadata itself, and the stdio server narrows to `CurrentBranchInput`
 * because it reads the shas, the diff and the scorer probe off the local checkout instead of taking them
 * from the caller -- serving less, and saying so, rather than advertising a field it ignores.
 */
export const LocalBranchAnalysisInput = CurrentBranchInput.extend({
  login: z.string().min(1).max(SCENARIO_LIMITS.branchRefChars),
  repoFullName: z.string().min(3).max(SCENARIO_LIMITS.repoFullNameChars),
  baseSha: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  mergeBaseSha: z.string().min(1).optional(),
  remoteTrackingSha: z.string().min(1).optional(),
  commitMessages: z.array(z.string()).max(30).optional(),
  changedFiles: z.array(changedFileSchema).max(500).optional(),
  validation: z.array(validationEntrySchema).max(50).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(SCENARIO_MAX_LINKED_ISSUE_NUMBERS).optional(),
  focusManifest: focusManifestInputSchema.optional(),
  /** What a local scoring run reported, when the caller ran one. */
  localScorer: z
    .object({
      mode: z.enum(["metadata_only", "external_command", "gittensor_root"]),
      activeModel: z.string().optional(),
      sourceTokenScore: z.number().min(0).optional(),
      totalTokenScore: z.number().min(0).optional(),
      sourceLines: z.number().min(0).optional(),
      testTokenScore: z.number().min(0).optional(),
      nonCodeTokenScore: z.number().min(0).optional(),
      warnings: z.array(z.string()).optional(),
    })
    .optional(),
});

export const preflightCurrentBranchTool = defineTool({
  name: "loopover_preflight_current_branch",
  title: "Preflight current branch",
  description:
    "Analyze the current git branch and return PR readiness. Sends metadata only.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalBranchAnalysisInput,
  output: PreflightCurrentBranchOutput,
});

export const previewCurrentBranchScoreTool = defineTool({
  name: "loopover_preview_current_branch_score",
  title: "Preview current branch score",
  description:
    "Analyze the current git branch and return private scoreability context. Sends metadata only.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalBranchAnalysisInput,
  output: PreviewCurrentBranchScoreOutput,
});

export const rankLocalNextActionsTool = defineTool({
  name: "loopover_rank_local_next_actions",
  title: "Rank local next actions",
  description:
    "Analyze the current git branch and rank local next actions by private reward/risk and review friction.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalBranchAnalysisInput,
  output: RankLocalNextActionsOutput,
});

export const explainLocalBlockersTool = defineTool({
  name: "loopover_explain_local_blockers",
  title: "Explain local blockers",
  description:
    "Analyze the current git branch and explain private scoreability, lane, and review blockers.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalBranchAnalysisInput,
  output: ExplainLocalBlockersOutput,
});

export const remediationPlanTool = defineTool({
  name: "loopover_remediation_plan",
  title: "Remediation plan",
  description:
    "Analyze the current git branch and return an ordered public-safe remediation checklist with rerun conditions.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalBranchAnalysisInput,
  output: RemediationPlanOutput,
});

export const preparePrPacketTool = defineTool({
  name: "loopover_prepare_pr_packet",
  title: "Prepare PR packet",
  description:
    "Analyze the current git branch and return a public-safe PR packet. Sends metadata only.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalBranchAnalysisInput,
  output: PrepareLocalPrPacketOutput,
});

export const agentPreparePrPacketTool = defineTool({
  name: "loopover_agent_prepare_pr_packet",
  title: "Agent: prepare PR packet",
  description:
    "Prepare a public-safe PR packet from current branch metadata. Sends metadata only.",
  // `branch`, not `agent`: the stdio server has always grouped it with the local-branch tools in
  // `loopover-mcp tools`, and the category is a listing affordance for a human, not a capability claim.
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalBranchAnalysisInput,
  output: AgentRunBundleOutput,
});

export const reviewPrBeforePushTool = defineTool({
  name: "loopover_review_pr_before_push",
  title: "Review PR before push",
  description:
    "Run a single composed pre-PR review of the current branch: preflight (lane/duplicate/linked-issue/test/queue fit), slop-risk, and PR-text lint, merged into one report with an overall pass/warn/fail status. Thin composition of the existing checks — does not reimplement any of them. Sends metadata only, no source upload.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: CurrentBranchInput,
  output: PreflightCurrentBranchOutput,
});

export const DraftPrBodyInput = LocalBranchAnalysisInput.extend({
  format: z.enum(["json", "markdown"]).optional(),
});
export const draftPrBodyTool = defineTool({
  name: "loopover_draft_pr_body",
  title: "Draft PR body",
  description:
    "Draft a public-safe, copy/paste PR body from local branch metadata (changed files, tests run, linked issue, duplicate/WIP caution, branch freshness, next steps). Private scoreability/reward/trust context is excluded; source contents are not uploaded. Optional format=markdown returns the rendered body as the primary payload.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: DraftPrBodyInput,
  output: DraftPrBodyOutput,
});

export const CompareLocalVariantsInput = z.object({
  variants: z.array(LocalBranchAnalysisInput).min(1).max(10),
});
/** What the STDIO server serves: each variant is analysed from the checkout, not from caller-supplied shas. */
export const StdioCompareLocalVariantsInput = z.object({
  variants: z.array(CurrentBranchInput).min(1).max(10),
});
export const compareLocalVariantsTool = defineTool({
  name: "loopover_compare_local_variants",
  title: "Compare local variants",
  description:
    "Compare current-branch metadata variants without uploading source contents.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: CompareLocalVariantsInput,
  output: CompareVariantsOutput,
});

// ── the supplied-metrics family ─────────────────────────────────────────────────────────────────

/**
 * What the score-preview surfaces take when the caller supplies the metrics itself rather than
 * having them read off a checkout.
 *
 * This is the shape whose remote counterpart carried the eligibility `.transform()`. See this
 * file's header: the transform is a control over the parsed value and stays on the server; what
 * a caller may send is exactly this.
 */
export const LocalScoreInput = z.object({
  repoFullName: z.string().min(3).max(SCENARIO_LIMITS.repoFullNameChars),
  cwd: z.string().optional(),
  baseRef: z.string().max(SCENARIO_LIMITS.branchRefChars).default("HEAD"),
  contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
  targetKey: z.string().optional(),
  title: z.string().max(PREFLIGHT_LIMITS.titleChars).optional(),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  tests: z.array(z.string()).optional(),
  authorAssociation: z.string().max(PREFLIGHT_LIMITS.authorAssociationChars).optional(),
  commitMessage: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  // Cap matches ExplainScoreBreakdownInput / api-requests so RemoteLocalScorePreviewInput is a
  // true narrowing of that contract field under checkInputNarrowing (#10041).
  scenarioNotes: z.array(z.string()).max(20).optional(),
  branchEligibility: callerBranchEligibilitySchema.optional(),
  scorePreviewCommand: z.string().optional(),
});

/**
 * The score-preview family's full vocabulary (#9662), and each server's declared narrowing of it.
 *
 * Same story as `LocalBranchAnalysisInput` above: the remote registered from a hand-written
 * `scorePreviewShape` in `src/mcp/server.ts` carrying eight scenario knobs the registry never described,
 * while `LocalScoreInput` carries nine fields only a server with a checkout can honour. Neither is the
 * contract on its own -- the union is, and each server states which part of it it serves rather than
 * advertising a field it silently overrides.
 */
/** The linked-issue provenance a caller may supply, as the remote has always accepted it. */
const linkedIssueContextSchema = z.strictObject({
  status: z.enum(["raw", "plausible", "validated", "invalid", "unavailable"]).optional(),
  source: z.enum(["user_supplied", "official_mirror", "github_cache", "issue_quality", "missing"]).optional(),
  issueNumbers: z.array(z.number().int().positive()).max(50).optional(),
  solvedByPullRequests: z.array(z.number().int().positive()).max(50).optional(),
  reason: z.string().optional(),
  warnings: z.array(z.string()).max(20).optional(),
});

export const LocalScorePreviewInput = LocalScoreInput.extend({
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("local_diff"),
  linkedIssueContext: linkedIssueContextSchema.optional(),
  testTokenScore: z.number().min(0).optional(),
  nonCodeTokenScore: z.number().min(0).optional(),
  existingContributorTokenScore: z.number().min(0).optional(),
  prAgeHours: z.number().min(0).optional(),
  duplicateRiskCount: z.number().int().min(0).optional(),
  metadataOnly: z.boolean().default(true),
});

/**
 * What the REMOTE serves: everything except the fields that only mean something to a server holding the
 * checkout. It cannot read a working directory, run a scorer command, or diff a branch, so it says so.
 */
export const RemoteLocalScorePreviewInput = LocalScorePreviewInput.omit({
  cwd: true,
  baseRef: true,
  title: true,
  body: true,
  linkedIssues: true,
  tests: true,
  authorAssociation: true,
  commitMessage: true,
  scorePreviewCommand: true,
});

export const previewLocalPrScoreTool = defineTool({
  name: "loopover_preview_local_pr_score",
  title: "Preview local PR score",
  description:
    "Inspect local diff metadata and request a private LoopOver scoring preview. No source contents are uploaded.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalScorePreviewInput,
  output: PreviewLocalPrScoreOutput,
});

export const getEligibilityPlanTool = defineTool({
  name: "loopover_get_eligibility_plan",
  title: "Get eligibility plan",
  description:
    "Derive a structured eligibility plan from local score-preview metadata: whether the branch/PR is eligible now, public-safe blockers, and cleanup paths. Advisory dry-run only — no GitHub writes.",
  category: "discovery",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: LocalScorePreviewInput,
  output: GetEligibilityPlanOutput,
});

export const ComparePrVariantsInput = z.object({
  // #9662: the same union each variant's SINGULAR tool takes, for the same reason -- the element type was
  // the stdio server's narrower one, so the remote's own handler accepted variants the registry rejected.
  variants: z.array(LocalScorePreviewInput).min(1).max(10),
});
/** What the STDIO server serves: each variant goes through its local preview, which supplies the rest. */
export const StdioComparePrVariantsInput = z.object({
  variants: z.array(LocalScoreInput).min(1).max(10),
});
export const comparePrVariantsTool = defineTool({
  name: "loopover_compare_pr_variants",
  title: "Compare PR variants",
  description:
    "Compare private LoopOver scoring previews across local/metadata variants.",
  category: "branch",
  auth: "token",
  locality: "local-git",
  availability: "both",
  input: ComparePrVariantsInput,
  output: CompareVariantsOutput,
});

// ── stdio-only ──────────────────────────────────────────────────────────────────────────────────

export const FeasibilityGateInput = z.object({
  claimStatus: z.enum(["unclaimed", "claimed", "solved", "unknown"]),
  duplicateClusterRisk: z.enum(["none", "low", "medium", "high"]),
  issueStatus: z.enum(["ready", "needs_proof", "hold", "do_not_use", "duplicate", "invalid", "missing"]),
  found: z.boolean().optional(),
  // #5157: when BOTH are supplied and a local loopover-miner claim ledger exists, `claimStatus` is
  // read from that ledger instead of trusting the caller's value. Omitting either keeps the
  // caller-supplied behaviour unchanged.
  repoFullName: z.string().min(1).max(SCENARIO_LIMITS.repoFullNameChars).optional(),
  issueNumber: z.number().int().positive().optional(),
});
export const FeasibilityGateOutput = z.looseObject({
  verdict: z.enum(FEASIBILITY_VERDICTS).optional(),
  reasons: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  claimSource: z.string().optional(),
});
export const feasibilityGateTool = defineTool({
  name: "loopover_feasibility_gate",
  title: "Feasibility gate",
  description:
    "Pure local go/raise/avoid feasibility verdict from claim status, duplicate-cluster risk, and issue quality/lifecycle status — the same discriminants the analyze-phase feasibility gate branches on. When repoFullName/issueNumber are supplied and a local loopover-miner install's claim ledger is present, claimStatus is read from that ledger instead of the caller-supplied value; otherwise falls back to the caller-supplied claimStatus unchanged. Advisory-only — never blocks, cancels, or overrides a claim or attempt; real claim-conflict resolution authority stays with the maintainer-only path. No API round-trip.",
  category: "discovery",
  auth: "public",
  locality: "local-git",
  availability: "both",
  input: FeasibilityGateInput,
  output: FeasibilityGateOutput,
});

// ── remote-proxying tools whose inputs converge here ────────────────────────────────────────────

export const MarkNotificationsReadInput = z.object({
  // REQUIRED (#9662): the notifications are per-contributor, and a server with no session cannot infer
  // whose they are. The stdio server, which does have one, narrows it away below -- the catalog told a
  // caller this was optional while the remote rejected the call, which is the drift that check exists for.
  login: z.string().min(1),
  ids: z.array(z.string().min(1).max(128)).max(100).optional(),
});

/** What the STDIO server serves: it resolves the login from the active profile's session. */
export const StdioMarkNotificationsReadInput = MarkNotificationsReadInput.partial({ login: true });
export const markNotificationsReadTool = defineTool({
  name: "loopover_mark_notifications_read",
  title: "Mark notifications read",
  description:
    "Mark a contributor's own delivered notifications as read (clears the badge). Self-scoped; pass `ids` to clear specific notifications or omit to clear all.",
  category: "utility",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: MarkNotificationsReadInput,
  output: MarkNotificationsReadOutput,
});

export const WatchIssuesInput = z.object({
  /** REQUIRED for the same reason as `MarkNotificationsReadInput.login`; the stdio server narrows it. */
  login: z.string().min(1),
  // `.default("list")` is a runtime coercion the emitted JSON Schema cannot round-trip, so it is
  // expressed as an optional field with the default stated in the description instead. Both servers
  // already treat an omitted action as "list".
  action: z.enum(["watch", "unwatch", "list"]).optional(),
  repoFullName: z.string().min(3).max(SCENARIO_LIMITS.repoFullNameChars).optional(),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
});
/** What the STDIO server serves: same session-filled `login` narrowing as its notifications sibling. */
export const StdioWatchIssuesInput = WatchIssuesInput.partial({ login: true });

export const watchIssuesTool = defineTool({
  name: "loopover_watch_issues",
  title: "Watch issues",
  description:
    "Watch repos for NEW grabbable, high-multiplier issues (maintainer-created, not WIP). action=watch subscribes a repo (optional label filter), unwatch removes it, list (default) returns your watches. When a matching issue opens you're notified via loopover_list_notifications. Self-scoped to the authenticated login.",
  category: "utility",
  auth: "token",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: WatchIssuesInput,
  output: WatchIssuesOutput,
});

/** Bounds taken from the remote copy, which had them; the stdio copy had none. */
export const FindOpportunitiesInput = z.object({
  targets: z
    .array(z.object({ owner: z.string().min(1).max(39), repo: z.string().min(1).max(100) }))
    .max(25)
    .optional(),
  searchQuery: z.string().min(1).max(500).optional(),
  goalSpec: z
    .object({
      lane: z.string().min(1).optional(),
      minRankScore: z.number().min(0).max(100).optional(),
      languages: z.array(z.string().min(1).max(30)).max(20).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const findOpportunitiesTool = defineTool({
  name: "loopover_find_opportunities",
  title: "Find opportunities",
  description:
    "Cross-repo discovery: find high-fit contribution opportunities across registered Gittensor repos. Returns a ranked, public-safe list filtered by your MinerGoalSpec (lane, min rank score, languages). Metadata-only, no GitHub writes.",
  category: "discovery",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: FindOpportunitiesInput,
  output: FindOpportunitiesOutput,
});

/** Same: the remote copy carried the bounds, the stdio copy carried none. */
export const RetrieveIssueContextInput = z.object({
  owner: z.string().max(39),
  repo: z.string().max(100),
  title: z.string().max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  topK: z.number().int().min(1).max(12).optional(),
});
export const retrieveIssueContextTool = defineTool({
  name: "loopover_retrieve_issue_context",
  title: "Retrieve issue context",
  description:
    "Repo-scoped issue-centric RAG retrieval for the miner analyze phase. Returns related file paths and retrieval scores from issue title/body/labels — metadata only, never source text.",
  category: "discovery",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: RetrieveIssueContextInput,
  output: RetrieveIssueContextOutput,
});

const openPrPressureCount = z.number().int().min(0).max(1_000_000);

/**
 * The one input in this file that stays `.looseObject` throughout.
 *
 * It is shared verbatim with `POST /v1/lint/open-pr-pressure` (#6751), and the queue-health payload
 * it carries is produced by the burden-forecast surface, which has added signal fields over time
 * without this tool changing. Closing it would make the next added signal a rejected call.
 */
export const SimulateOpenPrPressureInput = z.object({
  repoFullName: z.string().min(3).max(SCENARIO_LIMITS.repoFullNameChars),
  generatedAt: z.string().min(1).max(100),
  queueHealth: z
    .looseObject({
      repoFullName: z.string().min(3).max(SCENARIO_LIMITS.repoFullNameChars),
      generatedAt: z.string().min(1).max(100),
      burdenScore: z.number().finite(),
      level: z.enum(["low", "medium", "high", "critical"]),
      summary: z.string().max(1_000),
      signals: z.looseObject({
        openIssues: openPrPressureCount,
        openPullRequests: openPrPressureCount,
        unlinkedPullRequests: openPrPressureCount,
        stalePullRequests: openPrPressureCount,
        draftPullRequests: openPrPressureCount,
        maintainerAuthoredPullRequests: openPrPressureCount,
        collisionClusters: openPrPressureCount,
        ageBuckets: z.looseObject({
          under7Days: openPrPressureCount,
          days7To30: openPrPressureCount,
          over30Days: openPrPressureCount,
        }),
        likelyReviewablePullRequests: openPrPressureCount,
        cachedOpenPullRequests: openPrPressureCount.optional(),
        likelyReviewablePullRequestsSource: z.enum(["cache", "sampled_cache", "authoritative"]).optional(),
      }),
      findings: z.array(z.unknown()).max(100),
    })
    .nullable(),
  roleContext: z.looseObject({ maintainerLane: z.boolean() }),
  contributorOpenPrCount: openPrPressureCount.optional(),
});
export const simulateOpenPrPressureTool = defineTool({
  name: "loopover_simulate_open_pr_pressure",
  title: "Simulate open-PR pressure",
  description:
    "Rank what-if scenarios for easing a repo's open-PR pressure from already-computed queue-health metadata — deterministic, public-safe, and read-only. Needs no repo access and performs no GitHub writes.",
  category: "discovery",
  auth: "token",
  locality: "remote",
  availability: "both",
  input: SimulateOpenPrPressureInput,
  output: SimulateOpenPrPressureOutput,
});
