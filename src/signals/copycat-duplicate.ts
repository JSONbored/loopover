import { copycatWouldActOnPersistedScore } from "./copycat";
import type { CopycatGateMode, PullRequestRecord } from "../types";

/**
 * #9033: bridges the copycat/plagiarism containment engine's per-PR verdict (copycat-detection.ts,
 * src/signals/copycat.ts) into the duplicate-cluster machinery (queue/duplicate-detection.ts,
 * rules/advisory.ts), which previously keyed ENTIRELY on shared `linkedIssues` overlap -- so two PRs citing
 * DIFFERENT issues, one a near-identical copy of the other's added code, were never even considered duplicate-
 * cluster candidates, regardless of content similarity. Two colluding accounts (or one attacker with two
 * identities) could exploit exactly this gap to double-earn Gittensor rewards for one piece of work.
 *
 * Resolves `pr`'s already-PERSISTED copycat assessment (`copycatScore`/`copycatMatchedPullNumber`, written by
 * copycat-detection.ts's runCopycatAssessment during this PR's own gate evaluation -- never re-scored here) to
 * the specific OPEN sibling PR it names, when-and-only-when the containment engine would actually ACT on that
 * score under the repo's current effective `copycatGateMode`/`copycatGateMinScore` (mirrors
 * copycatWouldActOnPersistedScore's exact semantics: non-`off` mode, a real match, score >= threshold).
 *
 * Scoped to OPEN siblings only, by construction: `copycatMatchedPullNumber` can reference either a still-open
 * sibling (a live "two competing submissions for the same work" race -- exactly what duplicate-cluster election
 * exists to adjudicate) or an already-merged PR (prior art this PR copied from, with no "other side" to elect a
 * winner against -- that case is fully handled by copycatGateMode's own single-PR warn/label/block actuation,
 * see settings/agent-actions.ts). Passing only `otherOpenPullRequests` here means a merged-PR match can never
 * incorrectly surface as a duplicate-cluster sibling.
 */
export function resolveCopycatDuplicateSibling(
  pr: Pick<PullRequestRecord, "copycatScore" | "copycatMatchedPullNumber">,
  otherOpenPullRequests: readonly PullRequestRecord[],
  copycatGateMode: CopycatGateMode | null | undefined,
  copycatGateMinScore: number | null | undefined,
): PullRequestRecord | undefined {
  if (!copycatWouldActOnPersistedScore(pr.copycatScore, pr.copycatMatchedPullNumber, copycatGateMode, copycatGateMinScore)) return undefined;
  return otherOpenPullRequests.find((otherPr) => otherPr.number === pr.copycatMatchedPullNumber);
}
