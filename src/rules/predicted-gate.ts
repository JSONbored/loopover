import {
  buildCollisionReport,
  buildPreflightResult,
  buildPublicReadinessScore,
  buildQueueHealth,
  unionScopedOverlapClusters,
  type IssueQualityReport,
} from "../signals/engine";
import { buildFocusManifestGuidance, type FocusManifest } from "../signals/focus-manifest";
import { guardrailPathMatches, isGuardrailHit } from "../signals/change-guardrail";
import { resolveHardGuardrailGlobs } from "../review/guardrail-config";
import { sanitizePublicComment } from "../github/commands";
import { GITTENSOR_HOME_URL } from "../github/footer";
import type { BountyRecord, GatePolicyPack, IssueRecord, PullRequestRecord, RepositoryRecord } from "../types";

// Opt-in funnel (#694): a non-Gittensor adopter running the `oss-anti-slop` pack learns that Gittensor pays
// contributors for OSS work like this. Public-safe "earn" wording only (never reward/payout/score).
const OSS_ANTI_SLOP_FUNNEL = {
  message: "This repo runs the Gittensor anti-slop gate. Gittensor lets GitHub contributors earn for open-source work like this — register to start earning.",
  registerUrl: GITTENSOR_HOME_URL,
} as const;
import { buildPullRequestAdvisory, evaluateGateCheck } from "./advisory";
import { hasValidationNote, isTestPath } from "../signals/test-evidence";
import { evaluateClaCheck } from "../review/cla-check";
import { evaluatePreMergeChecks } from "../review/pre-merge-checks";

// PredictedGateVerdict/PredictedGateInput and the predictedGateNote/publicSafeFinding pure helpers now live in
// `@jsonbored/gittensory-engine` (#2276) so a miner can model the gate locally with the same shapes;
// buildPredictedGateVerdict itself follows in the keystone issue (#2283). Imported via the relative source path
// — this repo's engine-consumption convention (see src/scoring/preview.ts) — so `typecheck`/`test:coverage` do
// not depend on the engine's built `dist/`, which is not guaranteed present when they run in CI.
import {
  predictedGateNote,
  publicSafeFinding as buildPublicSafeFinding,
} from "../../packages/gittensory-engine/src/predicted-gate";
import type { PredictedGateInput, PredictedGateVerdict } from "../../packages/gittensory-engine/src/predicted-gate";

// Re-export the types so existing importers (test fixtures, engine-parity suites) keep resolving them here.
export type { PredictedGateInput, PredictedGateVerdict };

// publicSafeFinding lives in the engine but takes the redaction fn as an argument so the engine stays isolated from
// src/github/commands' sanitizePublicComment. Bind the canonical sanitizer here so the call sites below are unchanged.
const publicSafeFinding = (finding: { code: string; title: string; detail: string; action?: string | undefined }) =>
  buildPublicSafeFinding(finding, sanitizePublicComment);

/** GitHub full names are case-insensitive — mirror `sameRepo` in the live gate paths. */
function sameRepoFullName(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function buildPredictedGateVerdict(args: {
  input: PredictedGateInput;
  manifest: FocusManifest;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  bounties?: BountyRecord[] | undefined;
  issueQuality?: IssueQualityReport | null | undefined;
  /** The contributor's OWN confirmed-Gittensor status (self-data). Carried through for transparency only —
   *  it no longer changes the predicted verdict (the real gate fails any author on a configured blocker;
   *  confirmed-status affects only on-chain scoring). `undefined` → not resolved. */
  confirmedContributor?: boolean | undefined;
  /** The PR's changed file PATHS (metadata only — file paths, never source content, so the predictor stays
   *  metadata-only). When supplied, the path-dependent gates the live gate enforces are also predicted: the
   *  focus-manifest path policy and the path-gated pre-merge checks. Absent ⇒ only path-independent pre-merge
   *  checks are predicted and the note discloses the gap (#11-13/#18). */
  changedPaths?: string[] | undefined;
}): PredictedGateVerdict {
  const { input, manifest, repo, issues, pullRequests } = args;
  const gate = manifest.gate;
  const changedPaths = (args.changedPaths ?? []).filter((path) => typeof path === "string" && path.length > 0);
  const hasChangedPaths = changedPaths.length > 0;

  const preflight = buildPreflightResult(
    {
      repoFullName: input.repoFullName,
      contributorLogin: input.contributorLogin,
      title: input.title,
      body: input.body,
      labels: input.labels,
      linkedIssues: input.linkedIssues,
      authorAssociation: input.authorAssociation,
    },
    repo,
    issues,
    pullRequests,
    args.bounties ?? [],
    args.issueQuality,
  );

  // A synthetic open PR from the local branch metadata — fed to the SAME advisory builder as a real PR.
  // Use preflight's normalized linked issues so body references like "Closes #7" match real PR parity.
  const syntheticPr: PullRequestRecord = {
    repoFullName: input.repoFullName,
    number: 0,
    title: input.title,
    state: "open",
    authorLogin: input.contributorLogin,
    authorAssociation: input.authorAssociation ?? null,
    body: input.body ?? null,
    labels: input.labels ?? [],
    linkedIssues: preflight.linkedIssues,
  };

  const collisions = buildCollisionReport(input.repoFullName, issues, pullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
  const readiness = buildPublicReadinessScore({
    pr: syntheticPr,
    preflight,
    queueHealth,
    scopedOverlapCount: unionScopedOverlapClusters(collisions, syntheticPr, preflight.collisions).length,
  });

  // Linked-issue finding is surfaced when the repo's public policy treats it as anything but `off`, so the
  // gate can evaluate it; evaluateGateCheck decides whether it actually blocks (block) or stays advisory.
  // The composite mergeReadiness gate forces the linked-issue sub-gate on (applyMergeReadinessGate), and the
  // live path collects linked-issue evidence whenever merge-readiness is enabled (shouldCollectLinkedIssueEvidence,
  // queue/processors.ts), so the predictor must surface the finding under mergeReadiness too — otherwise a
  // `mergeReadiness:block` repo with linkedIssue unset predicts a false success while the live gate one-shot
  // closes the PR on the missing-linked-issue blocker. (#merge-readiness-parity)
  const requireLinkedIssue =
    (gate.linkedIssue !== null && gate.linkedIssue !== "off") || (gate.mergeReadiness !== null && gate.mergeReadiness !== "off");
  // `duplicateWinnerEnabled` is INTENTIONALLY omitted (#dup-winner): the prospective PR is synthetic #0, but a
  // real new PR opened into an existing duplicate cluster gets the HIGHEST number ⇒ it is always a duplicate
  // LOSER, never the winner. So the predictor must keep showing the duplicate finding (the honest pre-submit
  // answer). Threading the flag here would let isDuplicateClusterWinner(0, …) treat #0 as the winner and
  // falsely suppress the block — a false-optimism regression. Do NOT add it without modeling #0 as the loser.
  // Thread linked-issue authors from the issues snapshot so the predictor surfaces the self-authored-linked-issue
  // finding too — evaluateGateCheck below already receives gate.selfAuthoredLinkedIssue, but without this finding it
  // had nothing to act on, so a configured self-authored gate never showed in the preview. Offline path: resolved
  // from the snapshot, never a live fetch. (#self-authored-parity)
  const issueAuthorByNumber = new Map(issues.filter((issue) => sameRepoFullName(issue.repoFullName, input.repoFullName)).map((issue) => [issue.number, issue.authorLogin ?? null]));
  const linkedIssueAuthorLogins = syntheticPr.linkedIssues.map((issueNumber) => issueAuthorByNumber.get(issueNumber) ?? null);
  // Mirror the live gate (listOtherOpenPullRequests): repo-scoped open siblings only; closed/merged PRs sharing a
  // linked issue must not fire duplicate_pr_risk. authorHistory below still needs every state for its grace counts.
  const openSiblings = pullRequests.filter(
    (otherPr) =>
      otherPr.state === "open" &&
      sameRepoFullName(otherPr.repoFullName, input.repoFullName) &&
      otherPr.number !== syntheticPr.number,
  );
  const advisory = buildPullRequestAdvisory(repo, syntheticPr, { otherOpenPullRequests: openSiblings, requireLinkedIssue, linkedIssueAuthorLogins });

  // Deterministic pre-merge checks parity (#11/#18): the LIVE gate enforces the repo's `review.pre_merge_checks`
  // (from the SAME public .gittensory.yml the predictor already reads). With the PR's changed paths supplied,
  // evaluate ALL of them exactly as live (path-gated checks now have their `whenPaths` to match against); without
  // paths, evaluate only the PATH-INDEPENDENT checks (empty `whenPaths` — title/description/label assertions),
  // whose inputs are exactly the real PR's, and disclaim the path-gated ones in the note.
  const predictablePreMergeChecks = hasChangedPaths ? manifest.review.preMergeChecks : manifest.review.preMergeChecks.filter((check) => check.whenPaths.length === 0);
  advisory.findings.push(
    ...evaluatePreMergeChecks(predictablePreMergeChecks, { title: syntheticPr.title, body: syntheticPr.body, labels: syntheticPr.labels, changedPaths, filesResolved: hasChangedPaths }),
  );

  // CLA / license-compatibility gate parity (#2564): this metadata-only predictor never resolves a LIVE
  // check-run (it runs before the PR exists), so only the phrase-match detection method is predictable —
  // checkRunConclusion stays undefined, mirroring evaluateClaCheck's "not evaluated" contract for an
  // unresolved check-run. A repo relying solely on checkRunName (no consentPhrase configured) therefore
  // predicts no finding either way; the note below discloses this limitation.
  if (gate.claMode !== null && gate.claMode !== "off") {
    advisory.findings.push(...evaluateClaCheck({ consentPhrase: gate.claConsentPhrase, checkRunName: gate.claCheckRunName }, { body: syntheticPr.body, checkRunConclusion: undefined }));
  }

  // Focus-manifest path policy parity (#12): the LIVE gate (manifestPolicyGateMode) pushes the three enforceable
  // policy findings over the PR's changed paths. Mirror it when the caller supplied paths and the PUBLIC config
  // opts in — recompute the guidance and append ONLY the policy codes, then thread manifestPolicyGateMode into
  // evaluateGateCheck below so block-mode blocks (advisory stays a warning). Without paths, this is skipped.
  if (hasChangedPaths && gate.manifestPolicy !== null && gate.manifestPolicy !== "off") {
    const guidance = buildFocusManifestGuidance({
      manifest,
      changedPaths,
      labels: syntheticPr.labels,
      linkedIssueCount: syntheticPr.linkedIssues.length,
      testFileCount: changedPaths.filter((path) => isTestPath(path)).length,
      // Parity with the live gate (queue/processors.ts's manifestPolicyGateMode block): the predictor
      // already has the same PR body available via input.body, so a manifest_missing_tests prediction must
      // not stay stuck at "no validation evidence" when the real gate would already treat the body as evidence.
      passedValidationCount: hasValidationNote(input.body ?? "") ? 1 : 0,
    });
    const policyCodes = new Set(["manifest_linked_issue_required", "manifest_missing_tests"]);
    for (const finding of guidance.findings) {
      if (!policyCodes.has(finding.code)) continue;
      advisory.findings.push({
        code: finding.code,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        /* v8 ignore next -- the three policy findings always carry an action; the no-action arm is unreachable here. */
        ...(finding.action !== undefined ? { action: finding.action } : {}),
      });
    }
  }

  // Pack-aware (#693): under `oss-anti-slop` the gate blocks ANY author, so drop the confirmed-contributor
  // gate entirely (mirrors gateCheckPolicy). `gittensor` keeps it. Pack comes from the PUBLIC .gittensory.yml.
  const pack: GatePolicyPack = gate.pack ?? "gittensor";
  const effectiveConfirmedContributor = pack === "oss-anti-slop" ? undefined : args.confirmedContributor;

  // Case-insensitive author match so the PREDICTOR agrees with the live gate (which matches case-insensitively).
  // First-time grace is retained as compatibility context, but blocker findings are no longer softened by it.
  const contributorLoginLc = input.contributorLogin?.toLowerCase();
  const authorHistory = pullRequests.filter((pr) => sameRepoFullName(pr.repoFullName, input.repoFullName) && pr.authorLogin?.toLowerCase() === contributorLoginLc);

  const hardGuardrailGlobs = resolveHardGuardrailGlobs(manifest.settings);
  const evaluation = evaluateGateCheck(advisory, {
    linkedIssueGateMode: gate.linkedIssue ?? undefined,
    duplicatePrGateMode: gate.duplicates ?? undefined,
    qualityGateMode: gate.readinessMode ?? undefined,
    qualityGateMinScore: gate.readinessMinScore ?? null,
    aiReviewGateMode: gate.aiReviewMode ?? undefined,
    aiReviewCloseConfidence: gate.aiReviewCloseConfidence ?? null,
    mergeReadinessGateMode: gate.mergeReadiness ?? undefined,
    // #12: only meaningful when changed paths were supplied (the policy findings are pushed above only then);
    // absent paths ⇒ no manifest finding exists, so this mode has nothing to act on (byte-identical).
    manifestPolicyGateMode: gate.manifestPolicy ?? undefined,
    selfAuthoredLinkedIssueGateMode: gate.selfAuthoredLinkedIssue ?? undefined,
    // #2564: only meaningful when the finding was pushed above (gate.claMode opted in); byte-identical otherwise.
    claGateMode: gate.claMode ?? undefined,
    readinessScore: readiness.total,
    confirmedContributor: effectiveConfirmedContributor,
    firstTimeContributorGrace: gate.firstTimeContributorGrace ?? undefined,
    authorMergedPrCount: authorHistory.filter((pr) => pr.state === "merged" || pr.mergedAt).length,
    authorClosedUnmergedPrCount: authorHistory.filter((pr) => pr.state === "closed" && !pr.mergedAt).length,
    // Size-hold + guardrail-hold parity (#2458): only meaningful when changed paths were supplied — changedPaths
    // is the only size/guardrail input this metadata-only predictor ever receives, so without it neither can be
    // evaluated (byte-identical to before). changedLineCount is deliberately left unset: line-diff stats are
    // never sent to this predictor, so the size hold can only be predicted from file count (disclosed in the
    // note above) — never claim a line count this function has no way to know.
    sizeGateMode: gate.sizeMode ?? undefined,
    ...(hasChangedPaths
      ? {
          changedFileCount: changedPaths.length,
          guardrailHit: isGuardrailHit(changedPaths, hardGuardrailGlobs),
          guardrailMatches: guardrailPathMatches(changedPaths, hardGuardrailGlobs),
        }
      : {}),
  });

  return {
    predicted: true,
    basis: "public_config",
    pack,
    conclusion: evaluation.conclusion,
    title: sanitizePublicComment(evaluation.title),
    summary: sanitizePublicComment(evaluation.summary),
    readinessScore: readiness.total,
    confirmedContributor: effectiveConfirmedContributor,
    blockers: evaluation.blockers.map(publicSafeFinding),
    warnings: evaluation.warnings.map(publicSafeFinding),
    funnel: pack === "oss-anti-slop" ? { ...OSS_ANTI_SLOP_FUNNEL } : null,
    note: predictedGateNote(hasChangedPaths),
  };
}
