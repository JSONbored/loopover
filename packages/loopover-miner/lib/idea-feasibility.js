/** Pre-execution feasibility check for a freeform Rent-a-Loop idea (#5671).
 *
 * Runs post-schema-validation and pre-compute-allocation on an idea submission (the intake shape defined in
 * #4779), so a customer can no longer burn paid or free-trial compute on an idea that was never going to
 * succeed. It is the freeform-text counterpart to the metadata `feasibility` CLI (`feasibility-cli.js`, #4270).
 *
 * REUSED from feasibility-cli.js AS-IS:
 *   - the engine's pure `buildFeasibilityVerdict` composer and its `avoid > raise > go` precedence — an idea
 *     inherits exactly the same verdict machinery a metadata-resolved issue does, so there is no second,
 *     divergent decision surface;
 *   - the injectable-verdict test seam (`options.buildFeasibilityVerdict`), matching the CLI's convention.
 *
 * NEW for freeform text (#5671, per the #4779 rubric):
 *   - `deriveIdeaIssueStatus`, which computes the `issueStatus` discriminant from the idea's OWN structure
 *     instead of a resolved GitHub issue. An idea with no objective success signal is `invalid` (impossible to
 *     evaluate objectively) and is rejected before compute; an unresolvable target repo is `missing` (out of the
 *     loop's scope) and is flagged.
 *
 * OUT OF SCOPE (stays with #5136): judging abusive/illegal or semantically off-topic intent from prose — that is
 * a content-moderation policy call, not this deterministic structural gate.
 */
import { buildFeasibilityVerdict } from "@loopover/engine";

/** Verdict → caller-facing disposition. `go` proceeds to compute; `raise`/`avoid` gate it. */
const DISPOSITION_BY_VERDICT = { go: "proceed", raise: "flag", avoid: "reject" };

/**
 * Derive the feasibility `issueStatus` for a freeform idea from objective, structural signals only — never from
 * a semantic read of the prose.
 *
 * @param {{ acceptanceHints?: readonly string[] }} idea    schema-validated idea submission (#4779)
 * @param {{ targetResolvable: boolean }} resolved          objectively-resolved intake signals
 * @returns {"missing" | "invalid" | "ready"}
 */
export function deriveIdeaIssueStatus(idea, resolved) {
  // Out of the loop's scope: the idea does not resolve to a repo the loop can act on.
  if (!resolved.targetResolvable) return "missing";
  // Impossible to evaluate objectively: no declared success signal, so the loop could never test its own output.
  const objectiveSignals = idea.acceptanceHints?.length ?? 0;
  if (objectiveSignals === 0) return "invalid";
  return "ready";
}

/**
 * Assess a schema-validated idea's feasibility before compute is allocated.
 *
 * @param {{ acceptanceHints?: readonly string[] }} idea
 * @param {{ targetResolvable: boolean, claimStatus: string, duplicateClusterRisk: string }} resolved
 * @param {{ buildFeasibilityVerdict?: Function }} [options]  test seam; defaults to the engine composer
 * @returns {{ disposition: "proceed"|"flag"|"reject", verdict: string, issueStatus: string, reasons: string[], summary: string }}
 */
export function assessIdeaFeasibility(idea, resolved, options = {}) {
  const buildVerdict = options.buildFeasibilityVerdict ?? buildFeasibilityVerdict;
  const issueStatus = deriveIdeaIssueStatus(idea, resolved);
  const verdict = buildVerdict({
    found: resolved.targetResolvable,
    claimStatus: resolved.claimStatus,
    duplicateClusterRisk: resolved.duplicateClusterRisk,
    issueStatus,
  });
  return {
    disposition: DISPOSITION_BY_VERDICT[verdict.verdict],
    verdict: verdict.verdict,
    issueStatus,
    reasons: [...verdict.avoidReasons, ...verdict.raiseReasons],
    summary: verdict.summary,
  };
}
