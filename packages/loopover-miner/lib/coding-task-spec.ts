import { closeSync, constants as fsConstants, openSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  ACCEPTANCE_CRITERIA_FILENAME,
  buildAcceptanceCriteria,
  buildCollisionReport,
  buildFeasibilityVerdict,
  buildPromptPacket,
  feasibilityInputFromPreStartCheck,
  serializeAcceptanceCriteria,
  shouldWriteAcceptanceCriteria,
} from "@loopover/engine";
import type {
  AcceptanceCriteria,
  FeasibilityGateResult,
  FeasibilityVerdict,
  IssueRecord,
  PullRequestRecord,
} from "@loopover/engine";
import { neutralizePromptInjection } from "./prompt-injection-defense.js";
import { detectRepoStack, renderStackSummary } from "./stack-detection.js";
import type { RepoStackResult } from "./stack-detection.js";

export type CodingTaskIssue = {
  number: number;
  title: string;
  body?: string | null | undefined;
  labels?: string[] | undefined;
};

export type CodingTaskClaimLedger = {
  listClaims(filter: { repoFullName: string; status: string }): Array<{ issueNumber: number }>;
};

export type CodingTaskContext = { issues: IssueRecord[]; pullRequests: PullRequestRecord[] };

export type CodingTaskSpecInput = {
  repoFullName: string;
  issue: CodingTaskIssue;
  context: CodingTaskContext;
  claimLedger: CodingTaskClaimLedger;
  workingDirectory: string;
  /** Injectable stack detector (#4786); omitted falls back to stack-detection.js's real `detectRepoStack`. */
  detectRepoStack?: (repoPath: string) => RepoStackResult;
};

export type CodingTaskSpecResult =
  | { ready: false; verdict: FeasibilityVerdict; feasibility: FeasibilityGateResult }
  | {
      ready: true;
      verdict: FeasibilityVerdict;
      feasibility: FeasibilityGateResult;
      acceptanceCriteriaPath: string;
      instructions: string;
      title: string;
      body: string | undefined;
      labels: string[] | undefined;
      linkedIssues: number[];
    };

// Coding-task-spec builder (#5132, Wave 3.5 follow-up). The second gap discovered alongside #5132's CLI
// wiring: `IterateLoopInput.title`/`instructions`/`acceptanceCriteriaPath` had no builder anywhere in this
// package. `packages/loopover-engine/src/miner/acceptance-criteria.ts` already composes a PromptPacket +
// FeasibilityGateResult into an immutable AcceptanceCriteria document (and deliberately does NOT write it --
// "actually writing it into the attempt's worktree is the worktree primitive's job", per its own header) --
// this module is that caller: derives the four inputs from a real target issue + the already-fetched
// SelfReviewContext (#5145), then writes the file for real.
//
// issueStatus is intentionally left undefined when computing feasibility: buildIssueQualityReport (the only
// thing that could supply it) lives only in root src/signals/engine.ts and has never been extracted into
// @loopover/engine (same gap #5145's own header documents for `issueQuality`). This is not a
// fabrication -- feasibilityInputFromPreStartCheck's OWN documented default for a missing
// issueQualityStatus/lifecycle is "ready", the same honest-default precedent already established.
//
// Target-repo stack detection (#4786 / #4785 follow-up): `detectRepoStack` already returned a structured
// language/package-manager/command description, but nothing in the attempt path consumed it -- instructions
// were issue text + an acceptance-criteria path only. This module now appends that real stack summary (and
// any confidently-inferred validation commands) to the coding-agent prompt so the agent validates against
// THIS repository's tooling rather than assuming LoopOver/loopover CI, Codecov, or `npm run test:ci`.
//
// Prompt-injection defense (#4795): a target issue's title/body is a customer repo's own content -- on
// Rent-a-Loop, anyone who can open an issue on that repo can shape text the coding agent later reads as
// part of its own instructions. `neutralizePromptInjection` runs on both fields before they reach either
// the coding agent's instructions (buildInstructions) or the acceptance-criteria document's taskBrief
// (buildTaskBrief) -- the two places raw issue text is embedded into agent-facing prose. This is a
// DIFFERENT concern from prompt-packet.ts's sanitizePromptPacketField (already applied downstream to
// taskBrief via buildPromptPacket): that scrubs economic/identity terms and local paths, not
// manipulation-shaped instructions, so both layers run and neither substitutes for the other.

function buildTaskBrief(issue: any) {
  const title = neutralizePromptInjection(issue.title).text;
  const body = neutralizePromptInjection((issue.body ?? "").trim()).text;
  return body ? `${title}\n\n${body}` : title;
}

function buildConstraints(issue: any) {
  if (!Array.isArray(issue.labels) || issue.labels.length === 0) return "";
  return `Labels on this issue: ${issue.labels.join(", ")}.`;
}

function buildFeasibilityNotes(feasibility: any) {
  return [feasibility.summary, ...feasibility.avoidReasons, ...feasibility.raiseReasons].join("\n");
}

// Only ever resolves to "claimed"/"unclaimed": the claim ledger's own ClaimStatus vocabulary
// ("active"|"released"|"expired") has no "solved" concept for FeasibilityClaimStatus's "solved" value to
// map from -- that would need real evidence a PR already resolved the issue (e.g. a merged, linked PR),
// which this function doesn't have access to. Not fabricated; genuinely undetectable from claim data alone.
function resolveClaimStatus(claimLedger: any, repoFullName: any, issueNumber: any) {
  const claims = claimLedger.listClaims({ repoFullName, status: "active" });
  return claims.some((claim: any) => claim.issueNumber === issueNumber) ? "claimed" : "unclaimed";
}

// The target issue's own raw cluster risk from buildCollisionReport (newly exported from
// @loopover/engine's public barrel) -- "none" when the issue isn't part of any cluster at all.
// DELIBERATELY does NOT apply #5145's ">= 2 pull_request items" threshold: that gate exists specifically to
// stop inDuplicateCluster (self-review, "does MY OWN just-created submission look redundant") from firing on
// the ordinary case of one existing PR already legitimately closing the issue. Feasibility asks a different
// question -- "should I even START working on this issue" -- where an issue already having ANY open PR
// against it (buildCollisionReport's pairwise "shared linked issue" rule, which fires at "high" for exactly
// one PR) is a meaningful, real caution signal, not a false positive to filter out.
function resolveDuplicateClusterRisk(repoFullName: any, issues: any, pullRequests: any, issueNumber: any) {
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
 * @returns {import("@loopover/engine").FeasibilityGateResult}
 */
export function buildCodingTaskFeasibility(
  repoFullName: string,
  issue: CodingTaskIssue,
  context: CodingTaskContext,
  claimLedger: CodingTaskClaimLedger,
): FeasibilityGateResult {
  const found = context.issues.some((candidate: any) => candidate.number === issue.number);
  const claimStatus = resolveClaimStatus(claimLedger, repoFullName, issue.number);
  const duplicateClusterRisk = resolveDuplicateClusterRisk(repoFullName, context.issues, context.pullRequests, issue.number);
  const feasibilityInput = feasibilityInputFromPreStartCheck({ found, claimStatus, duplicateClusterRisk });
  return buildFeasibilityVerdict(feasibilityInput);
}

/**
 * Compose the immutable AcceptanceCriteria document for one target issue + its feasibility verdict.
 *
 * @param {{ title: string, body?: string | null, labels?: string[] }} issue
 * @param {import("@loopover/engine").FeasibilityGateResult} feasibility
 * @returns {import("@loopover/engine").AcceptanceCriteria}
 */
export function buildCodingTaskAcceptanceCriteria(
  issue: CodingTaskIssue,
  feasibility: FeasibilityGateResult,
): AcceptanceCriteria {
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
 * @param {import("@loopover/engine").AcceptanceCriteria} acceptanceCriteria
 * @returns {{ written: boolean, path: string | null }}
 */
function assertContainedPath(root: any, path: any) {
  const relativePath = relative(root, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return;
  throw new Error(`Refusing to write acceptance criteria outside the worktree: ${path}`);
}

export function writeAcceptanceCriteriaFile(
  workingDirectory: string,
  acceptanceCriteria: AcceptanceCriteria,
): { written: boolean; path: string | null } {
  if (!shouldWriteAcceptanceCriteria(acceptanceCriteria.verdict)) return { written: false, path: null };
  const root = realpathSync(workingDirectory);
  const path = join(root, ACCEPTANCE_CRITERIA_FILENAME);
  assertContainedPath(root, path);

  let fd;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, serializeAcceptanceCriteria(acceptanceCriteria), "utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  return { written: true, path };
}

/**
 * Prompt guidance derived from a real `detectRepoStack` result (#4786). Lists only commands the detector
 * confidently inferred -- a `null` command stays omitted rather than guessed -- and always tells the agent
 * not to assume LoopOver/loopover's own CI/coverage conventions.
 *
 * @param {import("./stack-detection.js").RepoStackResult} stack
 * @returns {string}
 */
function buildValidationGuidance(stack: any) {
  const lines = [
    `Detected target-repo stack: ${renderStackSummary(stack)}`,
    "",
    "Validate your change with THIS repository's own build/test/lint tooling from the stack summary above.",
    "Do not assume LoopOver/loopover CI conventions, Codecov patch coverage, or `npm run test:ci` unless those commands appear in the detected stack.",
  ];
  if (stack?.detected === true) {
    const commands = [
      stack.testCommand ? `- test: \`${stack.testCommand}\`` : null,
      stack.lintCommand ? `- lint: \`${stack.lintCommand}\`` : null,
      stack.buildCommand ? `- build: \`${stack.buildCommand}\`` : null,
      stack.formatCommand ? `- format: \`${stack.formatCommand}\`` : null,
    ].filter((entry) => entry !== null);
    if (commands.length > 0) {
      lines.push("", "Run these commands before finishing:", ...commands);
    } else {
      lines.push(
        "",
        "No build/test/lint/format commands were confidently inferred — discover and use this repo's own tooling rather than guessing.",
      );
    }
  }
  return lines.join("\n");
}

/**
 * The coding-agent driver's own prompt text (agent-sdk-driver.ts's header: "forwarded verbatim as the
 * prompt -- the acceptance-criteria document already lives inside the worktree", so this points to it
 * rather than repeating its content). Also carries the target repo's detected stack + validation commands
 * (#4786) so the agent does not default to loopover-specific CI assumptions.
 *
 * The issue's title/body are neutralized against prompt-injection (#4795) before embedding -- this is the
 * literal `prompt:` handoff to the coding agent (agent-sdk-driver.ts), so it's the primary place untrusted
 * repo content could otherwise redirect agent behavior.
 *
 * @param {{ number: number, title: string, body?: string | null }} issue
 * @param {string} acceptanceCriteriaPath
 * @param {import("./stack-detection.js").RepoStackResult} stack
 */
function buildInstructions(issue: any, acceptanceCriteriaPath: any, stack: any) {
  const title = neutralizePromptInjection(issue.title);
  const body = neutralizePromptInjection((issue.body ?? "").trim());
  if (title.injected || body.injected) {
    console.log(
      JSON.stringify({
        event: "prompt_injection_neutralized",
        issueNumber: issue.number,
        fields: [title.injected ? "title" : null, body.injected ? "body" : null].filter(Boolean),
      }),
    );
  }
  return [
    `Resolve the following GitHub issue in this repository: #${issue.number} -- ${title.text}`,
    "",
    body.text,
    "",
    `A structured acceptance-criteria document describing what "done" means for this attempt is at ${acceptanceCriteriaPath} -- read it and ensure your change satisfies every criterion before finishing.`,
    "",
    buildValidationGuidance(stack),
  ].join("\n");
}

/**
 * Full composition: feasibility -> acceptance criteria -> (if authorized) write the file -> detect the
 * target-repo stack (#4786) -> instructions. Returns `ready: false` (with the computed feasibility verdict,
 * for the caller to report) when the verdict is `raise`/`avoid` -- the caller should abandon the attempt
 * rather than proceed with no real acceptance-criteria file on disk.
 *
 * `detectRepoStack` is injectable so tests can assert both the detected and fail-closed undiscovered stack
 * branches without depending on real filesystem probes; omitted falls back to stack-detection.js's real
 * `detectRepoStack` (the production default).
 *
 * @param {{
 *   repoFullName: string, issue: { number: number, title: string, body?: string | null, labels?: string[] },
 *   context: { issues: Array<{ number: number }>, pullRequests: unknown[] },
 *   claimLedger: { listClaims: (filter: { repoFullName: string, status: string }) => Array<{ issueNumber: number }> },
 *   workingDirectory: string,
 *   detectRepoStack?: (repoPath: string) => import("./stack-detection.js").RepoStackResult,
 * }} input
 * @returns {import("./coding-task-spec.js").CodingTaskSpecResult}
 */
export function buildCodingTaskSpec(input: CodingTaskSpecInput): CodingTaskSpecResult {
  const feasibility = buildCodingTaskFeasibility(input.repoFullName, input.issue, input.context, input.claimLedger);
  const acceptanceCriteria = buildCodingTaskAcceptanceCriteria(input.issue, feasibility);
  const writeResult = writeAcceptanceCriteriaFile(input.workingDirectory, acceptanceCriteria);

  if (!writeResult.written) {
    return { ready: false, verdict: feasibility.verdict, feasibility };
  }

  // Real target-repo stack (#4786): detected from the prepared worktree's own manifests, not guessed from
  // loopover conventions. Fail-closed `{ detected: false }` results still reach the prompt (via
  // renderStackSummary) so the agent is told detection failed rather than silently defaulting to npm/Codecov.
  const detect = input.detectRepoStack ?? detectRepoStack;
  const stack = detect(input.workingDirectory);
  const acceptanceCriteriaPath = writeResult.path as string;

  return {
    ready: true,
    verdict: feasibility.verdict,
    feasibility,
    acceptanceCriteriaPath,
    instructions: buildInstructions(input.issue, acceptanceCriteriaPath, stack),
    title: input.issue.title,
    body: input.issue.body ?? undefined,
    labels: input.issue.labels,
    linkedIssues: [input.issue.number],
  };
}
