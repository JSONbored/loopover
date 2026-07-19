import { closeSync, constants as fsConstants, openSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ACCEPTANCE_CRITERIA_FILENAME, buildAcceptanceCriteria, buildCollisionReport, buildFeasibilityVerdict, buildPromptPacket, feasibilityInputFromPreStartCheck, serializeAcceptanceCriteria, shouldWriteAcceptanceCriteria, } from "@loopover/engine";
import { neutralizePromptInjection } from "./prompt-injection-defense.js";
import { detectRepoStack, renderStackSummary } from "./stack-detection.js";
function buildTaskBrief(issue) {
    const title = neutralizePromptInjection(issue.title).text;
    const body = neutralizePromptInjection((issue.body ?? "").trim()).text;
    return body ? `${title}\n\n${body}` : title;
}
function buildConstraints(issue) {
    if (!Array.isArray(issue.labels) || issue.labels.length === 0)
        return "";
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
// @loopover/engine's public barrel) -- "none" when the issue isn't part of any cluster at all.
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
function assertContainedPath(root, path) {
    const relativePath = relative(root, path);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath)))
        return;
    throw new Error(`Refusing to write acceptance criteria outside the worktree: ${path}`);
}
/**
 * Write the acceptance-criteria document into the prepared worktree -- only when its own verdict authorizes
 * it (shouldWriteAcceptanceCriteria: verdict === "go"). A raise/avoid verdict writes nothing; the caller is
 * expected to abandon the attempt rather than start it, per acceptance-criteria.ts's own documented design.
 */
export function writeAcceptanceCriteriaFile(workingDirectory, acceptanceCriteria) {
    if (!shouldWriteAcceptanceCriteria(acceptanceCriteria.verdict))
        return { written: false, path: null };
    const root = realpathSync(workingDirectory);
    const path = join(root, ACCEPTANCE_CRITERIA_FILENAME);
    assertContainedPath(root, path);
    let fd;
    try {
        fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, serializeAcceptanceCriteria(acceptanceCriteria), "utf8");
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
    return { written: true, path };
}
/**
 * Prompt guidance derived from a real `detectRepoStack` result (#4786). Lists only commands the detector
 * confidently inferred -- a `null` command stays omitted rather than guessed -- and always tells the agent
 * not to assume LoopOver/loopover's own CI/coverage conventions.
 */
function buildValidationGuidance(stack) {
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
        }
        else {
            lines.push("", "No build/test/lint/format commands were confidently inferred — discover and use this repo's own tooling rather than guessing.");
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
 */
function buildInstructions(issue, acceptanceCriteriaPath, stack) {
    const title = neutralizePromptInjection(issue.title);
    const body = neutralizePromptInjection((issue.body ?? "").trim());
    if (title.injected || body.injected) {
        console.log(JSON.stringify({
            event: "prompt_injection_neutralized",
            issueNumber: issue.number,
            fields: [title.injected ? "title" : null, body.injected ? "body" : null].filter(Boolean),
        }));
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
 */
export function buildCodingTaskSpec(input) {
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
    return {
        ready: true,
        verdict: feasibility.verdict,
        feasibility,
        acceptanceCriteriaPath: writeResult.path,
        instructions: buildInstructions(input.issue, writeResult.path, stack),
        title: input.issue.title,
        body: input.issue.body ?? undefined,
        labels: input.issue.labels,
        linkedIssues: [input.issue.number],
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29kaW5nLXRhc2stc3BlYy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvZGluZy10YXNrLXNwZWMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLElBQUksV0FBVyxFQUFFLFFBQVEsRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3JHLE9BQU8sRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUN2RCxPQUFPLEVBQ0wsNEJBQTRCLEVBQzVCLHVCQUF1QixFQUN2QixvQkFBb0IsRUFDcEIsdUJBQXVCLEVBQ3ZCLGlCQUFpQixFQUNqQixpQ0FBaUMsRUFDakMsMkJBQTJCLEVBQzNCLDZCQUE2QixHQUM5QixNQUFNLGtCQUFrQixDQUFDO0FBRTFCLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLCtCQUErQixDQUFDO0FBQzFFLE9BQU8sRUFBRSxlQUFlLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQXdDM0UsU0FBUyxjQUFjLENBQUMsS0FBc0I7SUFDNUMsTUFBTSxLQUFLLEdBQUcseUJBQXlCLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQztJQUMxRCxNQUFNLElBQUksR0FBRyx5QkFBeUIsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDdkUsT0FBTyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsS0FBSyxPQUFPLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDOUMsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsS0FBc0I7SUFDOUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssQ0FBQyxNQUFNLENB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