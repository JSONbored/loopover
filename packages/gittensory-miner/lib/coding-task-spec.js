import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTANCE_CRITERIA_FILENAME,
  buildAcceptanceCriteria,
  buildCollisionReport,
  buildFeasibilityVerdict,
  buildPromptPacket,
  feasibilityInputFromPreStartCheck,
  serializeAcceptanceCriteria,
  shouldWriteAcceptanceCriteria,
} from "@jsonbored/gittensory-engine";

// Coding-task-spec builder (#5132, Wave 3.5 follow-up). The second gap discovered alongside #5132's CLI
// wiring: `IterateLoopInput.title`/`instructions`/`acceptanceCriteriaPath` had no builder anywhere in this
// package. `packages/gittensory-engine/src/miner/acceptance-criteria.ts` already composes a PromptPacket +
// FeasibilityGateResult into an immutable AcceptanceCriteria document (and deliberately does NOT write it --
// "actually writing it into the attempt's worktree is the worktree primitive's job", per its own header) --
// this module is that caller: derives the four inputs from a real target issue + the already-fetched
// SelfReviewContext (#5145), then writes the file for real.
//
// issueStatus is intentionally left undefined when computing feasibility: buildIssueQualityReport (the only
// thing that could supply it) lives only in root src/signals/engine.ts and has never been extracted into
// @jsonbored/gittensory-engine (same gap #5145's own header documents for `issueQuality`). This is not a
// fabrication -- feasibilityInputFromPreStartCheck's OWN documented default for a missing
// issueQualityStatus/lifecycle is "ready", the same honest-default precedent already established.

function buildTaskBrief(issue) {
  const body = (issue.body ?? "").trim();
  return body ? `${issue.title}\n\n${body}` : issue.title;
}

function buildConstraints(issue) {
  if (!Array.isArray(issue.labels) || issue.labels.length === 0) return "";
  return `Labels on this issue: ${issue.labels.join(", ")}.`;
}

function buildFeasibilityNotes(feasibility) {
  return [feasibility.summary, ...feasibility.avoidReasons, ...feasibility.raiseReasons].join("\n");
}

// Only ever resolves to "claimed"/"unclaimed": the claim ledger's own ClaimStatus vocabulary
// ("active"|"released"|"expired") has no "solved" concept for FeasibilityClaimStatus's "solved" value to
// map from -- that would need real evidence a PR already resolved the issue (e.g. a merged, linked PR),
// which this function doesn't have access to. Not fabricated; genuinely undetectable from claim data alone.
function resolveClaimStatus(claimLedger, repoFullName, issueNumber) {
  const claims = claimLedger.listClaims({ repoFullName, status: "active" });
  return claims.some((claim) => claim.issueNumber === issueNumber) ? "claimed" : "unclaimed";
}

// The target issue's own raw cluster risk from buildCollisionReport (newly exported from
// @jsonbored/gittensory-engine's public barrel) -- "none" when the issue isn't part of any cluster at all.
// DELIBERATELY does NOT apply #5145's ">= 2 pull_request items" threshold: that gate exists specifically to
// stop inDuplicateCluster (self-review, "does MY OWN just-created submission look redundant") from firing on
// the ordinary case of one existing PR already legitimately closing the issue. Feasibility asks a different
// question -- "should I even START working on this issue" -- where an issue already having ANY open PR
// against it (buildCollisionReport's pairwise "shared linked issue" rule, which fires at "high" for exactly
// one PR) is a meaningful, real caution signal, not a false positive to filter out.
function resolveDuplicateClusterRisk(repoFullName, issues, pullRequests, issueNumber) {
  const report = buildCollisionReport(repoFullName, issues, pullRequests);
  const cluster = report.clusters.find((entry) => entry.items.some((item) => item.type === "issue" && item.number === issueNumber));
  return cluster ? cluster.risk : "none";
}

/**
 * Compute the feasibility verdict for one target issue, from real signals: whether the issue is present in
 * the fetched context, its real claim status (the claim ledger), and its real duplicate-cluster risk
 * (buildCollisionReport over the fetched issues/pullRequests). issueStatus is left to its documented
 * "ready" default -- see this file's header for why that's honest, not fabricated.
 *
 * @param {string} repoFullName
 * @param {{ number: number }} issue
 * @param {{ issues: Array<{ number: number }>, pullRequests: unknown[] }} context
 * @param {{ listClaims: (filter: { repoFullName: string, status: string }) => Array<{ issueNumber: number }> }} claimLedger
 * @returns {import("@jsonbored/gittensory-engine").FeasibilityGateResult}
 */
export function buildCodingTaskFeasibility(repoFullName, issue, context, claimLedger) {
  const found = context.issues.some((candidate) => candidate.number === issue.number);
  const claimStatus = resolveClaimStatus(claimLedger, repoFullName, issue.number);
  const duplicateClusterRisk = resolveDuplicateClusterRisk(repoFullName, context.issues, context.pullRequests, issue.number);
  const feasibilityInput = feasibilityInputFromPreStartCheck({ found, claimStatus, duplicateClusterRisk });
  return buildFeasibilityVerdict(feasibilityInput);
}

/**
 * Compose the immutable AcceptanceCriteria document for one target issue + its feasibility verdict.
 *
 * @param {{ title: string, body?: string | null, labels?: string[] }} issue
 * @param {import("@jsonbored/gittensory-engine").FeasibilityGateResult} feasibility
 * @returns {import("@jsonbored/gittensory-engine").AcceptanceCriteria}
 */
export function buildCodingTaskAcceptanceCriteria(issue, feasibility) {
  const promptPacket = buildPromptPacket({
    taskBrief: buildTaskBrief(issue),
    constraints: buildConstraints(issue),
    feasibilityNotes: buildFeasibilityNotes(feasibility),
    retrievalContext: "",
  });
  return buildAcceptanceCriteria({ promptPacket, feasibility });
}

/**
 * Write the acceptance-criteria document into the prepared worktree -- only when its own verdict authorizes
 * it (shouldWriteAcceptanceCriteria: verdict === "go"). A raise/avoid verdict writes nothing; the caller is
 * expected to abandon the attempt rather than start it, per acceptance-criteria.ts's own documented design.
 *
 * @param {string} workingDirectory
 * @param {import("@jsonbored/gittensory-engine").AcceptanceCriteria} acceptanceCriteria
 * @returns {{ written: boolean, path: string | null }}
 */
export function writeAcceptanceCriteriaFile(workingDirectory, acceptanceCriteria) {
  if (!shouldWriteAcceptanceCriteria(acceptanceCriteria.verdict)) return { written: false, path: null };
  const path = join(workingDirectory, ACCEPTANCE_CRITERIA_FILENAME);
  writeFileSync(path, serializeAcceptanceCriteria(acceptanceCriteria), "utf8");
  return { written: true, path };
}

/**
 * The coding-agent driver's own prompt text (agent-sdk-driver.ts's header: "forwarded verbatim as the
 * prompt -- the acceptance-criteria document already lives inside the worktree", so this points to it
 * rather than repeating its content).
 */
function buildInstructions(issue, acceptanceCriteriaPath) {
  return [
    `Resolve the following GitHub issue in this repository: #${issue.number} -- ${issue.title}`,
    "",
    (issue.body ?? "").trim(),
    "",
    `A structured acceptance-criteria document describing what "done" means for this attempt is at ${acceptanceCriteriaPath} -- read it and ensure your change satisfies every criterion before finishing.`,
  ].join("\n");
}

/**
 * Full composition: feasibility -> acceptance criteria -> (if authorized) write the file -> instructions.
 * Returns `ready: false` (with the computed feasibility verdict, for the caller to report) when the
 * verdict is `raise`/`avoid` -- the caller should abandon the attempt rather than proceed with no real
 * acceptance-criteria file on disk.
 *
 * @param {{
 *   repoFullName: string, issue: { number: number, title: string, body?: string | null, labels?: string[] },
 *   context: { issues: Array<{ number: number }>, pullRequests: unknown[] },
 *   claimLedger: { listClaims: (filter: { repoFullName: string, status: string }) => Array<{ issueNumber: number }> },
 *   workingDirectory: string,
 * }} input
 * @returns {import("./coding-task-spec.js").CodingTaskSpecResult}
 */
export function buildCodingTaskSpec(input) {
  const feasibility = buildCodingTaskFeasibility(input.repoFullName, input.issue, input.context, input.claimLedger);
  const acceptanceCriteria = buildCodingTaskAcceptanceCriteria(input.issue, feasibility);
  const writeResult = writeAcceptanceCriteriaFile(input.workingDirectory, acceptanceCriteria);

  if (!writeResult.written) {
    return { ready: false, verdict: feasibility.verdict, feasibility };
  }

  return {
    ready: true,
    verdict: feasibility.verdict,
    feasibility,
    acceptanceCriteriaPath: writeResult.path,
    instructions: buildInstructions(input.issue, writeResult.path),
    title: input.issue.title,
    body: input.issue.body ?? undefined,
    labels: input.issue.labels,
    linkedIssues: [input.issue.number],
  };
}
