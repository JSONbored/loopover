import { describe, expect, it } from "vitest";
import { buildPredictedGateVerdict, type PredictedGateInput } from "../../src/rules/predicted-gate";
import { parseFocusManifest } from "../../src/signals/focus-manifest";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

const REPO: RepositoryRecord = { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false };

function openPr(number: number, title: string, linkedIssues: number[] = [], authorLogin = "someone"): PullRequestRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", authorLogin, linkedIssues, labels: [] };
}

function openIssue(number: number, title: string, authorLogin: string | null = null): IssueRecord {
  return { repoFullName: "acme/widgets", number, title, state: "open", labels: [], linkedPrs: [], authorAssociation: null, authorLogin } as IssueRecord;
}

const BASE_INPUT: PredictedGateInput = {
  repoFullName: "acme/widgets",
  contributorLogin: "miner1",
  title: "Add retry to the upload client",
  body: "Closes #7",
  linkedIssues: [7],
};

function verdict(args: {
  gate: Record<string, unknown>;
  review?: Record<string, unknown>;
  manifestExtra?: Record<string, unknown>;
  changedPaths?: string[];
  input?: Partial<PredictedGateInput>;
  issues?: IssueRecord[];
  pullRequests?: PullRequestRecord[];
}) {
  return buildPredictedGateVerdict({
    input: { ...BASE_INPUT, ...args.input },
    manifest: parseFocusManifest({ gate: args.gate, ...(args.review ? { review: args.review } : {}), ...(args.manifestExtra ?? {}) }),
    repo: REPO,
    issues: args.issues ?? [openIssue(7, "Uploads should retry on 5xx")],
    pullRequests: args.pullRequests ?? [],
    ...(args.changedPaths ? { changedPaths: args.changedPaths } : {}),
  });
}

describe("buildPredictedGateVerdict", () => {
  it("predicts a pass for a clean diff with a linked issue and no duplicate", () => {
    const result = verdict({ gate: { duplicates: "block", linkedIssue: "advisory" } });
    expect(result.predicted).toBe(true);
    expect(result.basis).toBe("public_config");
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toHaveLength(0);
    expect(result.note).toContain("public .gittensory.yml");
  });

  it("threads gate.aiReview.closeConfidence into the policy without disturbing the public-config verdict (#7)", () => {
    // The predictor builds the advisory from PUBLIC metadata only (no AI finding exists), so a closeConfidence
    // floor has nothing to act on — the verdict stays a clean pass. This exercises the truthy `?? null` branch.
    const result = verdict({ gate: { duplicates: "block", linkedIssue: "advisory", aiReview: { mode: "block", closeConfidence: 0.4 } } });
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toHaveLength(0);
  });

  it("predicts a BLOCK when a duplicate PR exists and duplicates:block (the default)", () => {
    // Another open PR already targets the same linked issue → duplicate_pr_risk.
    const result = verdict({ gate: { duplicates: "block" }, pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])] });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);
    // Public-safe: blocker text carries a fix and no raw internal markers.
    expect(result.title.toLowerCase()).toContain("gittensory orb review agent");
  });

  it("does NOT raise duplicate_pr_risk for an open PR in a different repo sharing the same issue number (repo-scoped parity)", () => {
    const result = verdict({
      gate: { duplicates: "block" },
      pullRequests: [{ ...openPr(42, "Other repo retry", [7], "someone-else"), repoFullName: "other/repo" }],
    });
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(false);
    expect(result.conclusion).toBe("success");
  });

  it("does NOT block on a duplicate when duplicates:off", () => {
    const result = verdict({ gate: { duplicates: "off" }, pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])] });
    expect(result.conclusion).not.toBe("failure");
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(false);
  });

  it("does NOT raise duplicate_pr_risk for closed/merged siblings sharing the linked issue (open-only parity with the live gate)", () => {
    // A merged PR and an abandoned closed PR both share the new PR's linked issue, but neither is still
    // competing, so the predictor must not flag a duplicate.
    const result = verdict({
      gate: { duplicates: "block" },
      pullRequests: [
        { ...openPr(100, "Earlier upload retry", [7], "someone-else"), state: "merged", mergedAt: "2026-06-01T00:00:00.000Z" },
        { ...openPr(101, "Abandoned upload retry", [7], "someone-else"), state: "closed" },
      ],
    });
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(false);
    expect(result.conclusion).toBe("success");
  });

  it("predicts a BLOCK for a missing linked issue only when linkedIssue:block", () => {
    const blocked = verdict({ gate: { linkedIssue: "block" }, input: { body: "no issue here", linkedIssues: [] }, issues: [] });
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);

    // Default (advisory) → not a hard blocker.
    const advisory = verdict({ gate: { linkedIssue: "advisory" }, input: { body: "no issue here", linkedIssues: [] }, issues: [] });
    expect(advisory.blockers.some((b) => b.code === "missing_linked_issue")).toBe(false);
  });

  it("predicts a BLOCK for a self-authored linked issue when gate.selfAuthoredLinkedIssue:block (#self-authored-parity)", () => {
    // miner1 links issue #7 which miner1 also authored → self_authored_linked_issue (resolved from the snapshot).
    const blocked = verdict({ gate: { selfAuthoredLinkedIssue: "block" }, issues: [openIssue(7, "Uploads should retry on 5xx", "miner1")] });
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.some((b) => b.code === "self_authored_linked_issue")).toBe(true);

    // Repo full names are case-insensitive on GitHub — mixed-case snapshot must still resolve the author.
    const mixedCaseRepo = verdict({
      gate: { selfAuthoredLinkedIssue: "block" },
      input: { repoFullName: "acme/widgets" },
      issues: [{ ...openIssue(7, "Uploads should retry on 5xx", "miner1"), repoFullName: "Acme/Widgets" }],
    });
    expect(mixedCaseRepo.conclusion).toBe("failure");
    expect(mixedCaseRepo.blockers.some((b) => b.code === "self_authored_linked_issue")).toBe(true);

    // Authored by someone else → no self-authored finding.
    const otherAuthor = verdict({ gate: { selfAuthoredLinkedIssue: "block" }, issues: [openIssue(7, "Uploads should retry on 5xx", "reporter")] });
    expect(otherAuthor.blockers.some((b) => b.code === "self_authored_linked_issue")).toBe(false);

    // A linked issue absent from the snapshot resolves to a null author → no self-authored finding (fail-open).
    const notInSnapshot = verdict({ gate: { selfAuthoredLinkedIssue: "block" }, input: { body: "Closes #99", linkedIssues: [99] }, issues: [] });
    expect(notInSnapshot.blockers.some((b) => b.code === "self_authored_linked_issue")).toBe(false);
  });

  it("uses linked issues inferred from the body for gate advisory parity", () => {
    const result = verdict({ gate: { linkedIssue: "block" }, input: { body: "Closes #7", linkedIssues: [] } });
    expect(result.conclusion).toBe("success");
    expect(result.blockers.some((b) => b.code === "missing_linked_issue")).toBe(false);
  });

  it("honors public gate.mergeReadiness when predicting blockers", () => {
    const result = verdict({
      gate: { duplicates: "off", mergeReadiness: "block" },
      pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])],
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);
  });

  it("surfaces the missing-linked-issue blocker under composite mergeReadiness even when linkedIssue is unset (#merge-readiness-parity)", () => {
    // mergeReadiness:block forces the composite linked-issue sub-gate to block; the live gate collects
    // linked-issue evidence whenever merge-readiness is on (shouldCollectLinkedIssueEvidence), so the
    // predictor must surface the finding here too — otherwise it shows a false success while the live gate
    // one-shot auto-closes the PR. linkedIssue is left unset (null), so only the mergeReadiness term applies.
    const blocked = verdict({ gate: { duplicates: "off", mergeReadiness: "block" }, input: { body: "no issue here", linkedIssues: [] }, issues: [] });
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);

    // With neither linkedIssue nor mergeReadiness set, no missing-linked-issue finding is created (the
    // false/false arm of the new condition) — matching the live gate, which collects no linked-issue evidence.
    const noGate = verdict({ gate: { duplicates: "off" }, input: { body: "no issue here", linkedIssues: [] }, issues: [] });
    expect(noGate.blockers.some((b) => b.code === "missing_linked_issue")).toBe(false);
  });

  it("does not let public gate.firstTimeContributorGrace soften duplicate blockers", () => {
    const newcomer = verdict({
      gate: { duplicates: "block", firstTimeContributorGrace: true },
      pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7], "someone-else")],
    });
    expect(newcomer.conclusion).toBe("failure");
    expect(newcomer.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);

    const returning = verdict({
      gate: { duplicates: "block", firstTimeContributorGrace: true },
      pullRequests: [
        openPr(42, "Retry uploads on 5xx responses", [7], "someone-else"),
        { ...openPr(9, "Earlier fix", [], "miner1"), state: "merged", mergedAt: "2026-06-01T00:00:00.000Z" },
      ],
    });
    expect(returning.conclusion).toBe("failure");
    expect(returning.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);
  });

  it("matches author history case-insensitively, like the live gate (#audit-§4)", () => {
    // The merged PR's author is "MINER1" (different case from the contributor "miner1"). The predictor still
    // counts it as history, but blocker disposition no longer depends on first-time grace.
    const mixedCase = verdict({
      gate: { duplicates: "block", firstTimeContributorGrace: true },
      pullRequests: [
        openPr(42, "Retry uploads on 5xx responses", [7], "someone-else"),
        { ...openPr(9, "Earlier fix", [], "MINER1"), state: "merged", mergedAt: "2026-06-01T00:00:00.000Z" },
      ],
    });
    expect(mixedCase.conclusion).toBe("failure");
  });

  it("keeps duplicate blockers for repeat offenders via the closed-unmerged author-count path", () => {
    // The author has 3 prior CLOSED-unmerged PRs (state === "closed" && !mergedAt) in this repo. Blocker
    // disposition no longer depends on first-time grace, so the gate blocks either way.
    const closedUnmerged = (number: number, title: string): PullRequestRecord => ({
      ...openPr(number, title, [], "miner1"),
      state: "closed",
    });
    const result = verdict({
      gate: { duplicates: "block", firstTimeContributorGrace: true },
      pullRequests: [
        openPr(42, "Retry uploads on 5xx responses", [7], "someone-else"),
        closedUnmerged(11, "Abandoned attempt one"),
        closedUnmerged(12, "Abandoned attempt two"),
        closedUnmerged(13, "Abandoned attempt three"),
      ],
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);
  });

  it("counts a closed-but-merged PR as merge history via the mergedAt fallback (not state === merged)", () => {
    // The prior PR has state "closed" yet carries a mergedAt timestamp, so it is still counted as merge history.
    // Blocker disposition no longer depends on first-time grace, so the gate blocks either way.
    const result = verdict({
      gate: { duplicates: "block", firstTimeContributorGrace: true },
      pullRequests: [
        openPr(42, "Retry uploads on 5xx responses", [7], "someone-else"),
        { ...openPr(9, "Earlier merged fix", [], "miner1"), state: "closed", mergedAt: "2026-06-01T00:00:00.000Z" },
      ],
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "duplicate_pr_risk")).toBe(true);
  });

  it("predicts a non-confirmed contributor NORMALLY — a blocker → failure, matching the real gate (#gate-nonconfirmed)", () => {
    const result = buildPredictedGateVerdict({
      input: { ...BASE_INPUT, body: "no issue", linkedIssues: [] },
      manifest: parseFocusManifest({ gate: { linkedIssue: "block" } }),
      repo: REPO,
      issues: [],
      pullRequests: [],
      confirmedContributor: false, // confirmed status no longer changes the verdict — every author is gated the same
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);
  });

  it("predicts a BLOCK for an enforced path-INDEPENDENT pre-merge check the title fails (#11/#18)", () => {
    // The repo's public .gittensory.yml enforces a conventional-style title; the PR title lacks "[FEAT]".
    const result = verdict({
      gate: {},
      review: { pre_merge_checks: [{ name: "Conventional title", title_contains: "[FEAT]", enforce: true }] },
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "pre_merge_check_required")).toBe(true);
  });

  it("predicts a PASS once the path-independent pre-merge check is satisfied", () => {
    const result = verdict({
      gate: {},
      input: { title: "[FEAT] Add retry to the upload client" },
      review: { pre_merge_checks: [{ name: "Conventional title", title_contains: "[FEAT]", enforce: true }] },
    });
    expect(result.conclusion).not.toBe("failure");
    expect(result.blockers.some((b) => b.code === "pre_merge_check_required")).toBe(false);
  });

  it("surfaces a non-enforced path-independent pre-merge check as a WARNING, not a blocker", () => {
    const result = verdict({
      gate: {},
      review: { pre_merge_checks: [{ name: "Mention testing", description_contains: "tested", enforce: false }] },
    });
    expect(result.conclusion).not.toBe("failure");
    expect(result.warnings.some((w) => w.code === "pre_merge_check_failed")).toBe(true);
  });

  it("does NOT predict a path-GATED pre-merge check pre-submission (no diff) and discloses the gap in the note (#11/#18)", () => {
    // A path-gated check whose title assertion the PR fails — but it is scoped to changed paths, which are
    // unknown pre-submission, so it must be skipped (not falsely block) and called out in the note.
    const result = verdict({
      gate: {},
      review: { pre_merge_checks: [{ name: "Tests for src", title_contains: "ZZZ-never", when_paths: ["src/**"], enforce: true }] },
    });
    expect(result.blockers.some((b) => b.code === "pre_merge_check_required")).toBe(false);
    expect(result.warnings.some((w) => w.code === "pre_merge_check_unresolved")).toBe(false);
    expect(result.note).toContain("scoped to changed paths");
    expect(result.note.toLowerCase()).toContain("slop");
  });

  it("with changedPaths supplied, predicts a path-GATED pre-merge check that now matches (#11/#18)", () => {
    const result = verdict({
      gate: {},
      changedPaths: ["src/upload/client.ts"],
      review: { pre_merge_checks: [{ name: "Tests for src", title_contains: "ZZZ-never", when_paths: ["src/**"], enforce: true }] },
    });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "pre_merge_check_required")).toBe(true);
  });

  it("with changedPaths that do NOT match, the path-gated check is N/A (no finding)", () => {
    const result = verdict({
      gate: {},
      changedPaths: ["docs/readme.md"],
      review: { pre_merge_checks: [{ name: "Tests for src", title_contains: "ZZZ-never", when_paths: ["src/**"], enforce: true }] },
    });
    expect(result.blockers.some((b) => b.code === "pre_merge_check_required")).toBe(false);
  });

  it("predicts a BLOCK when gate.claMode: block + consentPhrase is configured and the PR body lacks it (#2564)", () => {
    const result = verdict({ gate: { claMode: "block", cla: { consentPhrase: "I agree to the CLA" } } });
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "cla_consent_missing")).toBe(true);
  });

  it("predicts a PASS once the CLA consent phrase is present in the PR body", () => {
    const result = verdict({
      gate: { claMode: "block", cla: { consentPhrase: "I agree to the CLA" } },
      input: { body: "Closes #7\n\nI agree to the CLA." },
    });
    expect(result.conclusion).not.toBe("failure");
    expect(result.blockers.some((b) => b.code === "cla_consent_missing")).toBe(false);
  });

  it("surfaces a missing CLA consent as a WARNING under claMode: advisory, never a blocker", () => {
    const result = verdict({ gate: { claMode: "advisory", cla: { consentPhrase: "I agree to the CLA" } } });
    expect(result.conclusion).not.toBe("failure");
    expect(result.warnings.some((w) => w.code === "cla_consent_missing")).toBe(true);
  });

  it("does NOT predict a cla_consent_missing finding when claMode is off (default, no opt-in)", () => {
    const result = verdict({ gate: {} });
    expect(result.blockers.some((b) => b.code === "cla_consent_missing")).toBe(false);
    expect(result.warnings.some((w) => w.code === "cla_consent_missing")).toBe(false);
  });

  it("a check-run-only CLA config (no consentPhrase) predicts a HOLD, never a false block, pre-submission (no live check-run data)", () => {
    // The metadata-only predictor never resolves a live check-run, so checkRunConclusion stays undefined —
    // and with no consentPhrase configured, evaluateClaCheck cannot confirm or deny consent, so it HOLDS
    // (cla_check_unresolved) rather than manufacturing a false cla_consent_missing block.
    const result = verdict({ gate: { claMode: "block", cla: { checkRunName: "CLA Assistant Lite" } } });
    expect(result.blockers.some((b) => b.code === "cla_consent_missing")).toBe(false);
    expect(result.conclusion).toBe("neutral");
  });

  it("maps legacy blockedPaths to a guardrail hold even when manifestPolicy:block is enabled (#12)", () => {
    const result = verdict({
      gate: { manifestPolicy: "block" },
      manifestExtra: { blockedPaths: ["dist/**"] },
      changedPaths: ["dist/bundle.js"],
    });
    expect(result.conclusion).toBe("neutral");
    expect(result.warnings.some((w) => w.code === "guardrail_hold")).toBe(true);
    expect(result.blockers.some((b) => b.code === "manifest_blocked_path")).toBe(false);
    expect(result.note).not.toContain("Provide the PR's changed paths");
    expect(result.note.toLowerCase()).toContain("slop");
  });

  it("maps legacy blockedPaths to a guardrail hold under manifestPolicy:advisory (#12)", () => {
    const result = verdict({
      gate: { manifestPolicy: "advisory" },
      manifestExtra: { blockedPaths: ["dist/**"] },
      changedPaths: ["dist/bundle.js"],
    });
    expect(result.conclusion).toBe("neutral");
    expect(result.warnings.some((w) => w.code === "guardrail_hold")).toBe(true);
  });

  it("manifestPolicy:off (default) emits NO manifest finding for legacy blockedPaths", () => {
    const result = verdict({
      gate: { manifestPolicy: "off" },
      manifestExtra: { blockedPaths: ["dist/**"] },
      changedPaths: ["dist/bundle.js"],
    });
    expect(result.blockers.some((b) => b.code === "manifest_blocked_path")).toBe(false);
    expect(result.warnings.some((w) => w.code === "manifest_blocked_path")).toBe(false);
    expect(result.warnings.some((w) => w.code === "guardrail_hold")).toBe(true);
  });

  it("ignores non-policy guidance findings (e.g. off-focus) — only enforceable policy codes are threaded (#12)", () => {
    // The path isn't blocked but it's outside the wanted areas → guidance emits the NON-policy `manifest_off_focus`.
    // The predictor must skip it (only linked-issue-required / missing-tests are gateable).
    const result = verdict({
      gate: { manifestPolicy: "block" },
      manifestExtra: { wantedPaths: ["src/**"] },
      changedPaths: ["docs/readme.md"],
    });
    expect(result.conclusion).not.toBe("failure");
    expect([...result.blockers, ...result.warnings].some((f) => f.code === "manifest_off_focus")).toBe(false);
  });

  // Regression tests for #2458: the predictor previously never threaded size/configured guardrail signals into
  // evaluateGateCheck, so it always predicted "success" even when the live gate would hold the same PR for
  // manual review (neutral → "manual").
  it("REGRESSION (#2458): predicts a size HOLD (neutral) when changedPaths exceeds the file-count threshold and gate.size.mode is on", () => {
    const manyFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`); // 12 > SIZE_HOLD_DEFAULT_MAX_FILES (10)
    const result = verdict({ gate: { size: { mode: "advisory" }, duplicates: "block" }, changedPaths: manyFiles });
    expect(result.conclusion).toBe("neutral");
    expect(result.warnings.some((w) => w.code === "oversized_pr")).toBe(true);
    expect(result.blockers).toHaveLength(0); // a HOLD, never a hard failure
  });

  it("does NOT predict a size hold when gate.size.mode is unset (off by default), even with many changed files", () => {
    const manyFiles = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);
    const result = verdict({ gate: { duplicates: "block" }, changedPaths: manyFiles });
    expect(result.conclusion).toBe("success");
    expect(result.warnings.some((w) => w.code === "oversized_pr")).toBe(false);
  });

  it("does NOT predict a size hold for a PR within the file-count threshold even when gate.size.mode is on", () => {
    const result = verdict({ gate: { size: { mode: "advisory" }, duplicates: "block" }, changedPaths: ["src/upload/client.ts"] });
    expect(result.conclusion).toBe("success");
    expect(result.warnings.some((w) => w.code === "oversized_pr")).toBe(false);
  });

  it("REGRESSION (#2458): predicts a guardrail HOLD (neutral) when changedPaths hits a configured hard-guardrail path", () => {
    const result = verdict({
      gate: { duplicates: "block" },
      manifestExtra: { settings: { hardGuardrailGlobs: [".github/workflows/**"] } },
      changedPaths: [".github/workflows/ci.yml"],
    });
    expect(result.conclusion).toBe("neutral");
    expect(result.warnings.some((w) => w.code === "guardrail_hold")).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("does NOT predict a guardrail hold when hardGuardrailGlobs is omitted", () => {
    const result = verdict({ gate: { duplicates: "block" }, changedPaths: [".github/workflows/ci.yml"] });
    expect(result.conclusion).toBe("success");
    expect(result.warnings.some((w) => w.code === "guardrail_hold")).toBe(false);
  });

  it("does NOT predict a guardrail hold when hardGuardrailGlobs is explicitly empty", () => {
    const result = verdict({
      gate: { duplicates: "block" },
      manifestExtra: { settings: { hardGuardrailGlobs: [] } },
      changedPaths: [".github/workflows/ci.yml"],
    });
    expect(result.conclusion).toBe("success");
    expect(result.warnings.some((w) => w.code === "guardrail_hold")).toBe(false);
  });

  it("does NOT predict a guardrail hold for an ordinary changed path", () => {
    const result = verdict({ gate: { duplicates: "block" }, changedPaths: ["src/upload/client.ts"] });
    expect(result.conclusion).toBe("success");
    expect(result.warnings.some((w) => w.code === "guardrail_hold")).toBe(false);
  });

  it("REGRESSION (#2458): the note discloses the file-count-only size caveat once changedPaths are supplied, replacing the no-paths disclaimer", () => {
    const withoutPaths = verdict({ gate: {} });
    expect(withoutPaths.note).toContain("Provide the PR's changed paths");
    expect(withoutPaths.note).not.toContain("FILE count only");

    const withPaths = verdict({ gate: {}, changedPaths: ["src/upload/client.ts"] });
    expect(withPaths.note).not.toContain("Provide the PR's changed paths");
    expect(withPaths.note).toContain("FILE count only");
  });
});

describe("pack-aware prediction (#693)", () => {
  it("defaults to the gittensor pack and surfaces it", () => {
    expect(verdict({ gate: { duplicates: "block" } }).pack).toBe("gittensor");
  });

  it("surfaces the earn funnel only under oss-anti-slop (#694), public-safe", () => {
    expect(verdict({ gate: { duplicates: "block" } }).funnel).toBeNull();
    const oss = verdict({ gate: { pack: "oss-anti-slop", duplicates: "block" } });
    expect(oss.funnel).not.toBeNull();
    expect(oss.funnel?.registerUrl).toBe("https://gittensor.io");
    expect(oss.funnel?.message.toLowerCase()).toContain("earn");
    expect(JSON.stringify(oss.funnel)).not.toMatch(/reward|payout|trust score|wallet/i);
  });

  it("under oss-anti-slop, blocks ANY author — even a self-declared non-confirmed contributor", () => {
    const result = buildPredictedGateVerdict({
      input: { ...BASE_INPUT, body: "no issue", linkedIssues: [] },
      manifest: parseFocusManifest({ gate: { pack: "oss-anti-slop", linkedIssue: "block" } }),
      repo: REPO,
      issues: [],
      pullRequests: [],
      confirmedContributor: false, // ignored under oss-anti-slop
    });
    expect(result.pack).toBe("oss-anti-slop");
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);
    expect(result.confirmedContributor).toBeUndefined();
  });

  it("under gittensor, a non-confirmed contributor is predicted FAILURE on a blocker (matches the real gate, #gate-nonconfirmed)", () => {
    const result = buildPredictedGateVerdict({
      input: { ...BASE_INPUT, body: "no issue", linkedIssues: [] },
      manifest: parseFocusManifest({ gate: { pack: "gittensor", linkedIssue: "block" } }),
      repo: REPO,
      issues: [],
      pullRequests: [],
      confirmedContributor: false,
    });
    expect(result.pack).toBe("gittensor");
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);
    // Confirmed status is still surfaced for transparency — it just no longer changes the verdict.
    expect(result.confirmedContributor).toBe(false);
  });

  it("runs on a non-Gittensor (app-installed, unregistered) repo under oss-anti-slop with no Gittensor account", () => {
    const result = buildPredictedGateVerdict({
      input: { ...BASE_INPUT, body: "no issue", linkedIssues: [] },
      manifest: parseFocusManifest({ gate: { pack: "oss-anti-slop", linkedIssue: "block" } }),
      // App-installed but NOT Gittensor-registered: a real repo record (not null → gittensory has "seen" it).
      repo: { ...REPO, isRegistered: false },
      issues: [],
      pullRequests: [],
    });
    expect(result.pack).toBe("oss-anti-slop");
    expect(result.conclusion).toBe("failure");
    expect(result.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);
  });
});
