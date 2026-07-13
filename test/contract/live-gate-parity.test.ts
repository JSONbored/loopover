/**
 * A TRUE live-gate-vs-predicted-gate cross-check (#4257).
 *
 * `test/contract/engine-parity.test.ts` is a SELF-consistency regression detector: it diffs
 * `buildPredictedGateVerdict`'s output against committed golden fixtures, catching "predicted-gate's output
 * silently changed." It does NOT verify predicted-gate's output still agrees with what the REAL live gate
 * (`src/queue/processors.ts`, via `gateCheckPolicy` + `buildPullRequestAdvisory` + `evaluateGateCheck` in
 * `src/queue/gate-checks.ts` / `src/rules/advisory.ts`) would decide for the same PR.
 *
 * This suite closes that gap WITHOUT a live GitHub/DB round-trip: it replays each of the same 14
 * predicted-gate fixtures through BOTH paths --
 *   - PREDICTED: `buildPredictedGateVerdict` (`packages/gittensory-engine/src/predicted-gate.ts`), which
 *     internally uses the ENGINE package's OWN `buildPullRequestAdvisory`/`evaluateGateCheck`
 *     (`packages/gittensory-engine/src/advisory/gate-advisory.ts`) and reads gate policy directly from the
 *     manifest's public `.gittensory.yml`.
 *   - LIVE: this file's own `buildLiveGateVerdict`, which mirrors predicted-gate's assembly steps (synthetic
 *     PR, advisory, pre-merge/CLA/manifest-policy findings -- reusing the SAME exported pure helpers with
 *     the SAME inputs, so no independent reimplementation risk there) but resolves the gate-check ARGS via
 *     the REAL production path: `resolveEffectiveSettings` + `gateCheckPolicy` (`src/queue/gate-checks.ts`)
 *     feeding the ROOT src twin `buildPullRequestAdvisory`/`evaluateGateCheck` (`src/rules/advisory.ts`) --
 *     the actual functions `src/queue/processors.ts` calls for a real PR.
 *
 * What this catches that `engine-parity.test.ts` cannot:
 *   1. Behavioral drift between the two hand-maintained gate-decision twins (`src/rules/advisory.ts` <->
 *      `packages/gittensory-engine/src/advisory/gate-advisory.ts`) -- `scripts/check-engine-parity.ts` only
 *      checks these for 4 marker-string presence, NOT full behavioral equivalence (see its own
 *      `GATE_DECISION_TWIN_PAIR` doc comment: "deliberately maintained as structurally divergent
 *      implementations").
 *   2. Drift between `gateCheckPolicy`'s DB-settings-based policy mapping and predicted-gate's inline
 *      manifest-based policy mapping -- two independent hand-written config -> gate-check-args
 *      translations that could silently diverge (e.g. a new settings field added to one and forgotten in
 *      the other).
 *
 * Known, INTENTIONAL boundary (not a bug this suite should flag): predicted-gate never receives diff
 * content, a live check-run, or AI-review output, so `slopGateMode`/`slopRisk`, the AI low-confidence
 * disposition, and `lockfileIntegrityGateMode` are never modeled on the predicted side (see
 * `PREDICTED_GATE_NOTE_SLOP`). Comparing the FINAL `evaluateGateCheck` decision -- not the raw policy args
 * objects -- means this never produces a false mismatch from those omissions: none of these fixtures'
 * advisories carry a slop/lockfile/AI finding for those fields to gate in the first place.
 */
import { describe, expect, it } from "vitest";

import { buildPredictedGateVerdict } from "../../src/rules/predicted-gate";
import { evaluateClaCheck } from "../../src/review/cla-check";
import { resolveHardGuardrailGlobs } from "../../src/review/guardrail-config";
import { evaluatePreMergeChecks } from "../../src/review/pre-merge-checks";
import { buildPullRequestAdvisory, evaluateGateCheck } from "../../src/rules/advisory";
import { gateCheckPolicy } from "../../src/queue/gate-checks";
import { isGuardrailHit, guardrailPathMatches } from "../../src/signals/change-guardrail";
import { buildFocusManifestGuidance, resolveEffectiveSettings } from "../../src/signals/focus-manifest";
import { hasValidationNote } from "../../src/signals/test-evidence";
import type { PullRequestRecord, RepositorySettings } from "../../src/types";
import { predictedGateFixtures, type PredictedGateFixture } from "../fixtures/engine-parity/predicted-gate";

// A repo with NO DB-only overrides: resolveEffectiveSettings then reflects ONLY the fixture's manifest,
// matching predicted-gate's own "public config + safe defaults" boundary exactly.
const NO_DB_OVERRIDES = {} as unknown as RepositorySettings;

function sameRepoFullName(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

/** Mirrors predicted-gate.ts's own synthetic-PR construction, minus its optional body-text "Closes #N"
 *  re-parse: a real PullRequestRecord's linkedIssues field is already resolved by the time gate-decision
 *  code sees it (that parsing happens at ingestion, not in the gate itself), so reusing the fixture's own
 *  explicit `input.linkedIssues` here matches what the live gate actually receives. */
function buildSyntheticPr(fixture: PredictedGateFixture): PullRequestRecord {
  return {
    repoFullName: fixture.input.repoFullName,
    number: 0,
    title: fixture.input.title,
    state: "open",
    authorLogin: fixture.input.contributorLogin,
    authorAssociation: fixture.input.authorAssociation ?? null,
    body: fixture.input.body ?? null,
    labels: fixture.input.labels ?? [],
    linkedIssues: fixture.input.linkedIssues ?? [],
  };
}

/**
 * The REAL live-gate decision for a fixture: same advisory-assembly steps as `buildPredictedGateVerdict`
 * (reusing the SAME exported pure helpers with the SAME inputs), but resolving the gate-check policy via
 * the REAL production path -- `resolveEffectiveSettings` + `gateCheckPolicy` -- instead of predicted-gate's
 * own inline `manifest.gate` mapping, and evaluating through the ROOT src (not engine package)
 * `buildPullRequestAdvisory`/`evaluateGateCheck` twin. `predicted.readinessScore`/`confirmedContributor` are
 * reused directly rather than recomputed: the readiness FORMULA and pack-based confirmed-contributor
 * adjustment are pre-submission-specific concerns already covered by `engine-parity.test.ts`'s own golden
 * fixtures, not part of the gate-decision-twin risk this suite targets.
 */
function buildLiveGateVerdict(fixture: PredictedGateFixture, predicted: ReturnType<typeof buildPredictedGateVerdict>) {
  const gate = fixture.manifest.gate;
  const changedPaths = (fixture.changedPaths ?? []).filter((path) => typeof path === "string" && path.length > 0);
  const hasChangedPaths = changedPaths.length > 0;

  const syntheticPr = buildSyntheticPr(fixture);
  const requireLinkedIssue =
    (gate.linkedIssue !== null && gate.linkedIssue !== "off") || (gate.mergeReadiness !== null && gate.mergeReadiness !== "off");
  const issueAuthorByNumber = new Map(
    fixture.issues
      .filter((issue) => sameRepoFullName(issue.repoFullName, fixture.input.repoFullName))
      .map((issue) => [issue.number, issue.authorLogin ?? null]),
  );
  const linkedIssueAuthorLogins = syntheticPr.linkedIssues.map((issueNumber) => issueAuthorByNumber.get(issueNumber) ?? null);
  const openSiblings = fixture.pullRequests.filter(
    (otherPr) =>
      otherPr.state === "open" &&
      sameRepoFullName(otherPr.repoFullName, fixture.input.repoFullName) &&
      otherPr.number !== syntheticPr.number,
  );

  const advisory = buildPullRequestAdvisory(fixture.repo, syntheticPr, {
    otherOpenPullRequests: openSiblings,
    requireLinkedIssue,
    linkedIssueAuthorLogins,
  });

  const predictablePreMergeChecks = hasChangedPaths
    ? fixture.manifest.review.preMergeChecks
    : fixture.manifest.review.preMergeChecks.filter((check) => check.whenPaths.length === 0);
  advisory.findings.push(
    ...evaluatePreMergeChecks(predictablePreMergeChecks, {
      title: syntheticPr.title,
      body: syntheticPr.body,
      labels: syntheticPr.labels,
      changedPaths,
      filesResolved: hasChangedPaths,
    }),
  );

  if (gate.claMode !== null && gate.claMode !== "off") {
    advisory.findings.push(
      ...evaluateClaCheck(
        { consentPhrase: gate.claConsentPhrase, checkRunName: gate.claCheckRunName },
        { body: syntheticPr.body, checkRunConclusion: undefined },
      ),
    );
  }

  if (hasChangedPaths && gate.manifestPolicy !== null && gate.manifestPolicy !== "off") {
    const guidance = buildFocusManifestGuidance({
      manifest: fixture.manifest,
      changedPaths,
      labels: syntheticPr.labels,
      linkedIssueCount: syntheticPr.linkedIssues.length,
      testFileCount: 0,
      passedValidationCount: hasValidationNote(syntheticPr.body ?? "") ? 1 : 0,
    });
    const policyCodes = new Set(["manifest_linked_issue_required", "manifest_missing_tests"]);
    for (const finding of guidance.findings) {
      if (!policyCodes.has(finding.code)) continue;
      advisory.findings.push({
        code: finding.code,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        ...(finding.action !== undefined ? { action: finding.action } : {}),
      });
    }
  }

  const contributorLoginLc = fixture.input.contributorLogin?.toLowerCase();
  const authorHistory = fixture.pullRequests.filter(
    (pr) => sameRepoFullName(pr.repoFullName, fixture.input.repoFullName) && pr.authorLogin?.toLowerCase() === contributorLoginLc,
  );
  const hardGuardrailGlobs = resolveHardGuardrailGlobs(fixture.manifest.settings);

  const effectiveSettings = resolveEffectiveSettings(NO_DB_OVERRIDES, fixture.manifest);
  const policy = gateCheckPolicy(
    effectiveSettings,
    predicted.readinessScore,
    predicted.confirmedContributor,
    null,
    {
      mergedPrCount: authorHistory.filter((pr) => pr.state === "merged" || pr.mergedAt).length,
      closedUnmergedPrCount: authorHistory.filter((pr) => pr.state === "closed" && !pr.mergedAt).length,
    },
    hasChangedPaths
      ? {
          changedFileCount: changedPaths.length,
          changedLineCount: 0,
          guardrailHit: isGuardrailHit(changedPaths, hardGuardrailGlobs),
          guardrailMatches: guardrailPathMatches(changedPaths, hardGuardrailGlobs),
        }
      : undefined,
  );

  return evaluateGateCheck(advisory, policy);
}

describe("live-gate-vs-predicted-gate cross-check (#4257)", () => {
  it("covers the same fixture set as engine-parity.test.ts (currently 14, not the 8 the issue was filed against)", () => {
    expect(predictedGateFixtures.length).toBeGreaterThanOrEqual(8);
  });

  it.each(predictedGateFixtures)("$id: the live gate agrees with the predicted-gate verdict", (fixture) => {
    const predicted = buildPredictedGateVerdict({
      input: fixture.input,
      manifest: fixture.manifest,
      repo: fixture.repo,
      issues: fixture.issues,
      pullRequests: fixture.pullRequests,
      ...(fixture.changedPaths ? { changedPaths: fixture.changedPaths } : {}),
    });
    const live = buildLiveGateVerdict(fixture, predicted);

    expect(live.conclusion).toBe(predicted.conclusion);
    expect(live.blockers.map((finding) => finding.code).sort()).toEqual(predicted.blockers.map((finding) => finding.code).sort());
    expect(live.warnings.map((finding) => finding.code).sort()).toEqual(predicted.warnings.map((finding) => finding.code).sort());
  });
});
