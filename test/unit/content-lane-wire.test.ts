import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_JUDGMENT_BLOCKER_CODES, type GateCheckEvaluation } from "../../src/rules/advisory";
import { applySurfaceGate, evaluateWithSurfaceLane, resolveSurfaceRefs, runRegistrySurfaceGate, surfaceVerdictToGate } from "../../src/review/content-lane-wire";
import type { SurfaceReviewInput } from "../../src/review/content-lane/orchestrator";
import { METAGRAPHED_LANE_SPEC } from "../../src/review/content-lane/registry-logic";
import { MAX_FETCH_CHARS } from "../../src/review/review-grounding";
import { parseFocusManifest, type FocusManifest } from "../../src/signals/focus-manifest";
import type { AdvisoryFinding } from "../../src/types";

const env = {} as unknown as Env;
const REPO = "JSONbored/metagraphed";
const SUBNET = "registry/subnets/foo.json";
const PROVIDER = "registry/providers/acme.json";
const existing = { kind: "website", url: "https://old.example.ai", source_url: "https://github.com/a/b", public_safe: true };
const newEntry = { kind: "subnet-api", url: "https://api.example.ai", source_url: "https://github.com/x/y", public_safe: true };
const doc = (surfaces: unknown[]) => JSON.stringify({ netuid: 14, surfaces });
const validProvider = JSON.stringify({ provider: { id: "acme", name: "Acme", website_url: "https://acme.example" } });

// A loadFile stub keyed by `${ref}:${path}` (mirrors the orchestrator test) so the adapter never hits the network.
const loader = (files: Record<string, string | null>): SurfaceReviewInput["loadFile"] => (path, ref) => Promise.resolve(files[`${ref}:${path}`] ?? null);
const gate = (over: Partial<GateCheckEvaluation>): GateCheckEvaluation => ({ enabled: true, conclusion: "success", title: "Gate", summary: "", blockers: [], warnings: [], ...over });
// A no-`contentLane:`-config manifest — evaluateWithSurfaceLane's resolver falls through to the
// LOOPOVER_REVIEW_REPOS allowlist default (METAGRAPHED_LANE_SPEC), matching today's zero-config behavior.
const noConfigManifest = (): Promise<FocusManifest> => Promise.resolve(parseFocusManifest(null));

afterEach(() => vi.unstubAllGlobals());

describe("surfaceVerdictToGate", () => {
  it("merge → success with no finding", () => {
    const { evaluation, finding } = surfaceVerdictToGate({ verdict: "merge", summary: "ok" });
    expect(evaluation.conclusion).toBe("success");
    expect(evaluation.blockers).toEqual([]);
    expect(finding).toBeNull();
  });

  it("close → failure with a single critical blocker that is NOT an AI-judgment code", () => {
    const { evaluation, finding } = surfaceVerdictToGate({ verdict: "close", summary: "bad entry" });
    expect(evaluation.conclusion).toBe("failure");
    expect(evaluation.blockers).toHaveLength(1);
    expect(evaluation.blockers[0]?.severity).toBe("critical");
    expect(finding?.code).toBe("surface_lane_reject");
    // Regression guard: deterministic surface blockers remain outside AI-judgment telemetry.
    expect(AI_JUDGMENT_BLOCKER_CODES.has(evaluation.blockers[0]!.code)).toBe(false);
  });

  it("manual → neutral with a warning (not a failing required check)", () => {
    const { evaluation, finding } = surfaceVerdictToGate({ verdict: "manual", summary: "auth declared" });
    expect(evaluation.conclusion).toBe("neutral");
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.warnings).toHaveLength(1);
    expect(finding?.code).toBe("surface_lane_manual");
  });

  it("falls back to a default summary when the verdict carries none", () => {
    expect(surfaceVerdictToGate({ verdict: "merge" }).evaluation.summary).toBe("Registry surface review.");
  });
});

describe("applySurfaceGate", () => {
  const surfaceClose = gate({ conclusion: "failure", blockers: [{ code: "surface_lane_reject", title: "S", severity: "critical", detail: "" }] });
  it("null surface defers to the generic gate", () => {
    const generic = gate({ conclusion: "success" });
    expect(applySurfaceGate(generic, null)).toBe(generic);
  });
  it("a missing generic gate yields the surface gate", () => {
    expect(applySurfaceGate(undefined, surfaceClose)).toBe(surfaceClose);
  });
  it("a clean generic gate (no blockers) lets the surface verdict stand", () => {
    expect(applySurfaceGate(gate({ conclusion: "success", blockers: [] }), surfaceClose)).toBe(surfaceClose);
  });
  it("preserves a generic manual-review hold over a surface merge", () => {
    const oversized: AdvisoryFinding = {
      code: "oversized_pr",
      title: "Large change — held for manual review",
      severity: "warning",
      detail: "This PR is large.",
    };
    const genericHold = gate({
      conclusion: "neutral",
      title: "LoopOver Orb Review Agent — held for manual review",
      summary: "Large change — held for manual review",
      blockers: [],
      warnings: [oversized],
    });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });

    expect(applySurfaceGate(genericHold, surfaceMerge)).toBe(genericHold);
  });
  it("lets a surface hard failure override a generic warning-only hold", () => {
    const genericHold = gate({
      conclusion: "neutral",
      blockers: [],
      warnings: [{ code: "oversized_pr", title: "Large change", severity: "warning", detail: "large" }],
    });

    expect(applySurfaceGate(genericHold, surfaceClose)).toBe(surfaceClose);
  });
  it("PRESERVES a generic hard blocker over a surface merge (a committed secret can never merge)", () => {
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked key" };
    const generic = gate({ conclusion: "failure", blockers: [secret], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(generic, surfaceMerge);
    expect(out?.conclusion).toBe("failure"); // the secret still blocks the merge
    expect(out?.blockers).toEqual([secret]); // the generic blocker survives the override
  });
  it("REGRESSION: an AI-judgment-only blocker (e.g. a hallucinated grounding/RAG claim) does not veto a decisive surface merge, and the generic gate's OTHER warnings survive", () => {
    const aiConsensusDefect: AdvisoryFinding = {
      code: "ai_consensus_defect",
      title: "AI reviewers agree on a likely critical defect",
      severity: "critical",
      detail: "the current registry context already tracks this netuid under a different slug",
    };
    // A warning unrelated to the (overridden) AI blocker — e.g. a quality-readiness note — must NOT vanish just
    // because the AI blocker next to it gets overridden.
    const qualityWarning: AdvisoryFinding = { code: "quality_readiness_low", title: "Readiness is low", severity: "warning", detail: "" };
    const genericAiOnly = gate({ conclusion: "failure", blockers: [aiConsensusDefect], warnings: [qualityWarning] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(genericAiOnly, surfaceMerge);
    // The surface lane is the sole, AI-free adjudicator for this structured data — an AI-judgment-only blocker
    // has no standing to override its merge (unlike the real secret_leak blocker in the test above).
    expect(out?.conclusion).toBe("success");
    expect(out?.blockers).toEqual([]);
    // The overridden AI blocker must NOT reappear (demoted or otherwise) — it was simply wrong. Only the
    // generic gate's unrelated warning, plus any surface warnings, survive.
    expect(out?.warnings).toEqual([qualityWarning]);
  });
  it("an AI-judgment-only generic failure still fails when the surface ITSELF closes (both agree, no override needed)", () => {
    const split: AdvisoryFinding = { code: "ai_review_split", title: "Split", severity: "critical", detail: "one reviewer flagged a defect" };
    const genericAiOnly = gate({ conclusion: "failure", blockers: [split], warnings: [] });
    const out = applySurfaceGate(genericAiOnly, surfaceClose);
    expect(out?.conclusion).toBe("failure");
    expect(out?.blockers).toEqual([split, ...surfaceClose.blockers]); // union — the AI-only exception only applies to a surface MERGE
  });
  it("#3907: aiJudgmentBlockersMode 'gate' skips the AI-judgment-only override — the finding survives into the failure union, reproducing PR #3910's shape", () => {
    // The exact repro this issue is about: a confidently-flagged, correct AI-judgment finding (a registry
    // provider slug semantically wrong for its domain) that the deterministic surface lane's own schema/shape
    // scan can never catch, so only AI judgment ever surfaces it.
    const providerMisattribution: AdvisoryFinding = {
      code: "ai_consensus_defect",
      title: "AI reviewers agree on a likely critical defect",
      severity: "critical",
      detail: "provider is set to \"loopover\" (an unrelated tool's slug) instead of \"gittensor\"",
    };
    const genericAiOnly = gate({ conclusion: "failure", blockers: [providerMisattribution], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "structurally valid entry" });
    const out = applySurfaceGate(genericAiOnly, surfaceMerge, { aiJudgmentBlockersMode: "gate" });
    // Opted in: the AI-judgment finding is NOT overridden — decision is no longer merge.
    expect(out?.conclusion).toBe("failure");
    expect(out?.blockers).toEqual([providerMisattribution]);
  });
  it("#3907: aiJudgmentBlockersMode 'advisory' (explicit) behaves identically to the default (unset) — byte-identical override", () => {
    const aiConsensusDefect: AdvisoryFinding = { code: "ai_consensus_defect", title: "AI defect", severity: "critical", detail: "" };
    const genericAiOnly = gate({ conclusion: "failure", blockers: [aiConsensusDefect], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const withExplicitAdvisory = applySurfaceGate(genericAiOnly, surfaceMerge, { aiJudgmentBlockersMode: "advisory" });
    const withDefault = applySurfaceGate(genericAiOnly, surfaceMerge);
    expect(withExplicitAdvisory).toEqual(withDefault);
    expect(withExplicitAdvisory?.conclusion).toBe("success");
  });
  it("a MIXED generic failure (an AI-judgment code plus a real blocker) is not AI-judgment-only — still overrides a surface merge", () => {
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked key" };
    const aiConsensusDefect: AdvisoryFinding = { code: "ai_consensus_defect", title: "AI defect", severity: "critical", detail: "" };
    const genericMixed = gate({ conclusion: "failure", blockers: [aiConsensusDefect, secret], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(genericMixed, surfaceMerge);
    expect(out?.conclusion).toBe("failure"); // the real blocker means this is NOT an AI-judgment-only failure
    expect(out?.blockers).toEqual([aiConsensusDefect, secret]);
  });

  // Bug #2 (confirmed live on metagraphed PR #2680): a duplicate_pr_risk finding (severity "warning"), escalated
  // into a blocker by duplicatePrGateMode: "block", must not singlehandedly one-shot-close a PR whose OWN
  // deterministic surface-lane result is a clean merge — it downgrades to a HOLD instead, same spirit as the
  // AI-judgment-only carve-out above, but keyed on this EXACT finding code (isDuplicateOnlyFailure), not severity.
  it("REGRESSION (#2680): a duplicate_pr_risk-only generic failure downgrades a clean surface merge to a HOLD, not a close — the finding stays visible with a held-for-review title/summary", () => {
    const duplicatePrRisk: AdvisoryFinding = {
      code: "duplicate_pr_risk",
      title: "Linked issue overlaps another open PR",
      severity: "warning",
      detail: "Other open pull requests reference the same linked issue set: #2654.",
    };
    const genericDuplicateOnly = gate({ conclusion: "failure", blockers: [duplicatePrRisk], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(genericDuplicateOnly, surfaceMerge);
    expect(out?.conclusion).toBe("neutral"); // held for review, not closed
    expect(out?.blockers).toEqual([]); // no longer a hard blocker
    expect(out?.warnings).toEqual([duplicatePrRisk]); // still visible to a human reviewer
    // The posted title/summary must name the actual hold reason, not silently inherit the surface's clean-merge text.
    expect(out?.title).toMatch(/held for review/i);
    expect(out?.summary).toBe(duplicatePrRisk.detail);
  });

  it("the held-for-review summary falls back to the blocker's title when its detail is blank", () => {
    const duplicatePrRisk: AdvisoryFinding = { code: "duplicate_pr_risk", title: "Linked issue overlaps another open PR", severity: "warning", detail: "" };
    const genericDuplicateOnly = gate({ conclusion: "failure", blockers: [duplicatePrRisk], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(genericDuplicateOnly, surfaceMerge);
    expect(out?.summary).toBe(duplicatePrRisk.title);
  });

  it("a duplicate-only generic failure downgrade preserves the generic gate's OTHER pre-existing warnings alongside the demoted blocker", () => {
    const duplicatePrRisk: AdvisoryFinding = { code: "duplicate_pr_risk", title: "Duplicate", severity: "warning", detail: "Overlaps #99." };
    const readiness: AdvisoryFinding = { code: "quality_readiness_low", title: "Readiness is low", severity: "warning", detail: "" };
    const genericDuplicateOnly = gate({ conclusion: "failure", blockers: [duplicatePrRisk], warnings: [readiness] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry", warnings: [] });
    const out = applySurfaceGate(genericDuplicateOnly, surfaceMerge);
    expect(out?.conclusion).toBe("neutral");
    expect(out?.warnings).toEqual([duplicatePrRisk, readiness]);
  });

  it("a MIXED generic failure (duplicate_pr_risk plus a genuinely critical finding) is NOT duplicate-only — still overrides a surface merge", () => {
    const duplicatePrRisk: AdvisoryFinding = { code: "duplicate_pr_risk", title: "Duplicate", severity: "warning", detail: "" };
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked key" };
    const genericMixed = gate({ conclusion: "failure", blockers: [duplicatePrRisk, secret], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(genericMixed, surfaceMerge);
    expect(out?.conclusion).toBe("failure"); // the real secret means this is NOT a duplicate-only failure
    expect(out?.blockers).toEqual([duplicatePrRisk, secret]);
  });

  it("a duplicate-only generic failure still fails when the surface ITSELF closes (the downgrade only applies to a surface MERGE)", () => {
    const duplicatePrRisk: AdvisoryFinding = { code: "duplicate_pr_risk", title: "Duplicate", severity: "warning", detail: "" };
    const genericDuplicateOnly = gate({ conclusion: "failure", blockers: [duplicatePrRisk], warnings: [] });
    const out = applySurfaceGate(genericDuplicateOnly, surfaceClose);
    expect(out?.conclusion).toBe("failure");
    expect(out?.blockers).toEqual([duplicatePrRisk, ...surfaceClose.blockers]); // union — no downgrade without a surface merge
  });

  // REGRESSION (scope-creep guard): several OTHER findings are ALSO severity "warning" and ALSO block-mode-
  // escalatable via their OWN independent maintainer-configured gate (linkedIssueGateMode /
  // selfAuthoredLinkedIssueGateMode / manifestPolicyGateMode). Guard #4 must be scoped to EXACTLY duplicate_pr_risk
  // — a maintainer who explicitly opted one of these into "block" must still have it close a clean-surface PR
  // outright, not get silently downgraded to a hold just because the finding happens to share duplicate_pr_risk's
  // "warning" severity.
  it.each(["missing_linked_issue", "self_authored_linked_issue", "manifest_linked_issue_required", "manifest_missing_tests"])(
    "REGRESSION: a %s-only generic failure (also severity warning, but a DIFFERENT maintainer-configured gate) still overrides a surface merge — not swept into the duplicate-only carve-out",
    (code) => {
      const otherWarningBlocker: AdvisoryFinding = { code, title: "t", severity: "warning", detail: "d" };
      const genericOtherOnly = gate({ conclusion: "failure", blockers: [otherWarningBlocker], warnings: [] });
      const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
      const out = applySurfaceGate(genericOtherOnly, surfaceMerge);
      expect(out?.conclusion).toBe("failure");
      expect(out?.blockers).toEqual([otherWarningBlocker]);
    },
  );
});

describe("runRegistrySurfaceGate (injected loader — adapter logic)", () => {
  const run = (files: { path: string; status?: string | null }[], stub: Record<string, string | null>, advisory = { findings: [] as AdvisoryFinding[] }) =>
    runRegistrySurfaceGate(env, METAGRAPHED_LANE_SPEC, { installationId: 0, repoFullName: REPO, pr: { headSha: "HEAD", baseRef: "BASE" }, advisory, files }, loader(stub));

  it("defers (null) for a non-submission PR", async () => {
    expect(await run([{ path: "README.md", status: "added" }], {})).toBeNull();
  });

  it("a valid provider submission → success, advisory left untouched (no finding)", async () => {
    const advisory = { findings: [] as AdvisoryFinding[] };
    const out = await run([{ path: PROVIDER, status: "added" }], { [`head:${PROVIDER}`]: validProvider }, advisory);
    expect(out?.conclusion).toBe("success");
    expect(advisory.findings).toEqual([]);
  });

  it("an invalid entry → failure, and pushes the reason into the advisory for the comment", async () => {
    const advisory = { findings: [] as AdvisoryFinding[] };
    const out = await run([{ path: SUBNET, status: "modified" }], { [`head:${SUBNET}`]: doc([existing, { ...newEntry, public_safe: false }]), [`base:${SUBNET}`]: doc([existing]) }, advisory);
    expect(out?.conclusion).toBe("failure");
    expect(advisory.findings.map((f) => f.code)).toEqual(["surface_lane_reject"]);
  });

  it("an unreadable head (transient fetch blip) DEFERS instead of auto-closing", async () => {
    expect(await run([{ path: SUBNET, status: "modified" }], { [`base:${SUBNET}`]: doc([existing]) })).toBeNull();
  });

  it("a null BASE on a MODIFIED file (transient blip) DEFERS — never a spurious close on a valid append", async () => {
    // Valid single-entry append, but the base fetch fails (null). Without the status-aware guard the orchestrator
    // would read base as [] → both head entries "new" → close. The "modified" status proves the base must exist.
    expect(await run([{ path: SUBNET, status: "modified" }], { [`head:${SUBNET}`]: doc([existing, newEntry]) })).toBeNull();
  });

  it("a null BASE on an ADDED file is the expected new-file case — NOT over-deferred (one entry merges)", async () => {
    const out = await run([{ path: SUBNET, status: "added" }], { [`head:${SUBNET}`]: doc([newEntry]) });
    expect(out?.conclusion).toBe("success");
  });

  it("a same-PR duplicate append (METAGRAPHED_LANE_SPEC's opt-in duplicateKeyFields) → failure end-to-end through the live adapter wiring", async () => {
    const advisory = { findings: [] as AdvisoryFinding[] };
    const copy = { ...newEntry, id: "a-copy" };
    const out = await run([{ path: SUBNET, status: "modified" }], { [`head:${SUBNET}`]: doc([existing, newEntry, copy]), [`base:${SUBNET}`]: doc([existing]) }, advisory);
    expect(out?.conclusion).toBe("failure");
    expect(advisory.findings.map((f) => f.code)).toEqual(["surface_lane_reject"]);
  });
});

// #7481-class fix: metagraphed PR #7481 was wrongly auto-closed with "must append at least one new surfaces[]
// entry" despite genuinely appending 35 entries, because the REAL GitHub loader (no loadFileOverride, hitting
// makeGithubFileFetcher directly) fetched HEAD content with no size cap, defaulting to 24_001 chars -- PR
// #7481's actual zipcode.json HEAD body was 67,085 bytes. The truncated (but non-null) prefix failed to
// parse as JSON, silently reading as "surfaces: null", which the existing null-only unreadable check never
// caught (a truncated fetch returns a real, non-null string). These tests exercise the REAL githubLoad path
// (not the injected-loader `run` helper above, which bypasses it entirely) via a stubbed global fetch, mirroring
// evaluateWithSurfaceLane's own "real GitHub loader" test.
describe("runRegistrySurfaceGate (#7481-class fix: oversized HEAD fetch defers instead of misreading as empty)", () => {
  const stubFetchWithBodies = (bodies: Record<string, string>) => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
  };
  const runReal = () =>
    runRegistrySurfaceGate(env, METAGRAPHED_LANE_SPEC, {
      installationId: 0,
      repoFullName: REPO,
      pr: { headSha: "HEAD", baseRef: "BASE" },
      advisory: { findings: [] },
      files: [{ path: SUBNET, status: "modified" }],
    });

  it("an oversized HEAD fetch (past MAX_FETCH_CHARS) DEFERS rather than closing on a misread 'zero entries appended'", async () => {
    stubFetchWithBodies({ [`HEAD:${SUBNET}`]: "a".repeat(MAX_FETCH_CHARS + 1000), [`BASE:${SUBNET}`]: doc([existing]) });
    expect(await runReal()).toBeNull();
  });

  it("an oversized BASE fetch on a MODIFIED file also DEFERS (same truncation risk on the other side of the diff)", async () => {
    stubFetchWithBodies({ [`HEAD:${SUBNET}`]: doc([existing, newEntry]), [`BASE:${SUBNET}`]: "b".repeat(MAX_FETCH_CHARS + 1000) });
    expect(await runReal()).toBeNull();
  });

  it("a HEAD fetch within MAX_FETCH_CHARS still parses and merges normally (no false-positive deferral)", async () => {
    stubFetchWithBodies({ [`HEAD:${SUBNET}`]: doc([existing, newEntry]), [`BASE:${SUBNET}`]: doc([existing]) });
    const out = await runReal();
    expect(out?.conclusion).toBe("success");
  });
});

describe("resolveSurfaceRefs", () => {
  it("resolves head + base, falling base back to the repo default branch then empty", () => {
    expect(resolveSurfaceRefs({ headSha: "H", baseRef: "B" }, { defaultBranch: "main" })).toEqual({ headSha: "H", baseRef: "B" });
    expect(resolveSurfaceRefs({ headSha: null, baseRef: null }, { defaultBranch: "main" })).toEqual({ headSha: "", baseRef: "main" });
    expect(resolveSurfaceRefs({}, null)).toEqual({ headSha: "", baseRef: "" });
  });
});

describe("evaluateWithSurfaceLane (the processor seam helper)", () => {
  const generic = gate({ conclusion: "success", summary: "generic" });
  const baseArgs = {
    installationId: null,
    pr: { headSha: "HEAD", baseRef: "BASE" },
    repo: { defaultBranch: "main" },
    advisory: { findings: [] as AdvisoryFinding[] },
    getChangedFiles: async () => {
      throw new Error("getChangedFiles must NOT be called when the lane is unwired");
    },
  };

  it("returns the generic gate unchanged when the gate is disabled (no file resolve)", async () => {
    expect(await evaluateWithSurfaceLane({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env, REPO, false, generic, baseArgs)).toBe(generic);
  });

  it("returns the generic gate unchanged when the lane is not wired (no file resolve)", async () => {
    expect(await evaluateWithSurfaceLane({} as unknown as Env, REPO, true, generic, baseArgs)).toBe(generic);
  });

  it("returns the generic gate unchanged when the flag is on but NO spec resolves for this repo (no config, not in the allowlist — no file resolve)", async () => {
    const unresolvedEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: "Some/OtherRepo" } as unknown as Env;
    expect(await evaluateWithSurfaceLane(unresolvedEnv, REPO, true, generic, baseArgs, noConfigManifest)).toBe(generic);
  });

  it("when wired, runs the surface lane via the real GitHub loader and overrides the gate", async () => {
    const bodies: Record<string, string> = {
      "HEAD:registry/subnets/foo.json": doc([existing, newEntry]),
      "BASE:registry/subnets/foo.json": doc([existing]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      REPO,
      true,
      generic,
      {
        installationId: null, // → unauthenticated fetcher; only the stub is hit
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory: { findings: [] },
        getChangedFiles: async () => [{ path: SUBNET, status: "modified" }],
      },
      noConfigManifest,
    );
    expect(out?.conclusion).toBe("success"); // a clean append merges, overriding the generic gate
  });

  it("REGRESSION: overriding an AI-judgment-only failure also strips the stale AI finding from advisory.findings (so the public comment can't contradict the merge)", async () => {
    const bodies: Record<string, string> = {
      "HEAD:registry/subnets/foo.json": doc([existing, newEntry]),
      "BASE:registry/subnets/foo.json": doc([existing]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    const aiConsensusDefect: AdvisoryFinding = { code: "ai_consensus_defect", title: "AI defect", severity: "critical", detail: "hallucinated" };
    const otherWarning: AdvisoryFinding = { code: "quality_readiness_low", title: "Readiness is low", severity: "warning", detail: "" };
    // Simulates the real pipeline: `runAiReviewForAdvisory` already pushed the SAME finding into advisory.findings
    // (consumed independently by the unified-comment bridge's consensusDefectFromFindings) before the generic gate
    // was evaluated from it.
    const advisory = { findings: [aiConsensusDefect, otherWarning] };
    const genericAiOnly = gate({ conclusion: "failure", blockers: [aiConsensusDefect], warnings: [] });
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      REPO,
      true,
      genericAiOnly,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: SUBNET, status: "modified" }],
      },
      noConfigManifest,
    );
    expect(out?.conclusion).toBe("success");
    // The overridden ai_consensus_defect must be gone from advisory.findings too — otherwise the unified-comment
    // bridge would still recover it via consensusDefectFromFindings and render "Concerns raised" over a merge.
    expect(advisory.findings).toEqual([otherWarning]);
  });

  it("#3907 REGRESSION: on an opted-in repo (gate.aiJudgmentBlockers: 'gate'), a confident AI-judgment-only finding survives a decisive surface merge — decision is no longer merge, and the finding stays in advisory.findings for the public comment", async () => {
    const bodies: Record<string, string> = {
      "HEAD:registry/subnets/foo.json": doc([existing, newEntry]),
      "BASE:registry/subnets/foo.json": doc([existing]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    const providerMisattribution: AdvisoryFinding = {
      code: "ai_consensus_defect",
      title: "AI reviewers agree on a likely critical defect",
      severity: "critical",
      detail: "provider is set to \"loopover\" instead of \"gittensor\"",
    };
    const advisory = { findings: [providerMisattribution] };
    const genericAiOnly = gate({ conclusion: "failure", blockers: [providerMisattribution], warnings: [] });
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const optedInManifest = (): Promise<FocusManifest> =>
      Promise.resolve(parseFocusManifest({ wantedPaths: ["src/"], gate: { aiJudgmentBlockers: "gate" } }));
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      REPO,
      true,
      genericAiOnly,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: SUBNET, status: "modified" }],
      },
      optedInManifest,
    );
    // The core deliverable: opted in, the AI-judgment finding is no longer overridden by the clean surface merge.
    expect(out?.conclusion).not.toBe("success");
    expect(out?.blockers).toEqual([providerMisattribution]);
    // Unlike the opted-out REGRESSION test above, the finding must NOT be stripped from advisory.findings —
    // it's now a real blocker, so the public comment needs to keep showing it.
    expect(advisory.findings).toEqual([providerMisattribution]);
  });

  it("#3907: an opted-OUT repo (no gate.aiJudgmentBlockers configured) is unaffected — byte-identical to the pre-#3907 REGRESSION test above", async () => {
    const bodies: Record<string, string> = {
      "HEAD:registry/subnets/foo.json": doc([existing, newEntry]),
      "BASE:registry/subnets/foo.json": doc([existing]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    const aiConsensusDefect: AdvisoryFinding = { code: "ai_consensus_defect", title: "AI defect", severity: "critical", detail: "hallucinated" };
    const advisory = { findings: [aiConsensusDefect] };
    const genericAiOnly = gate({ conclusion: "failure", blockers: [aiConsensusDefect], warnings: [] });
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      REPO,
      true,
      genericAiOnly,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: SUBNET, status: "modified" }],
      },
      noConfigManifest, // same zero-config manifest as the default-behavior tests above
    );
    expect(out?.conclusion).toBe("success"); // default advisory behavior: override still fires
    expect(advisory.findings).toEqual([]); // stripped, same as the pre-#3907 REGRESSION test
  });

  it("does NOT touch advisory.findings when the surface lane defers or the generic gate isn't AI-judgment-only", async () => {
    const aiConsensusDefect: AdvisoryFinding = { code: "ai_consensus_defect", title: "AI defect", severity: "critical", detail: "" };
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked" };
    const advisory = { findings: [aiConsensusDefect, secret] };
    // A real (non-AI) blocker alongside the AI one means isAiJudgmentOnlyFailure is false — no cleanup should run.
    const genericMixed = gate({ conclusion: "failure", blockers: [aiConsensusDefect, secret], warnings: [] });
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    await evaluateWithSurfaceLane(
      wiredEnv,
      REPO,
      true,
      genericMixed,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: "README.md", status: "modified" }], // not a registry submission → surface defers (null)
      },
      noConfigManifest,
    );
    expect(advisory.findings).toEqual([aiConsensusDefect, secret]);
  });

  it("defaults to the REAL loadRepoFocusManifest when no override is injected, and still degrades safely on a fake env", async () => {
    // No loadManifestOverride argument at all — exercises the production default (`loadManifestOverride ??
    // loadRepoFocusManifest`). A fake env with no D1 binding makes the real loader reject fast; `.catch(() =>
    // null)` still routes it to the allowlist-default resolution path rather than throwing out of this function.
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const out = await evaluateWithSurfaceLane(wiredEnv, REPO, true, generic, {
      installationId: null,
      pr: { headSha: "HEAD", baseRef: "BASE" },
      repo: { defaultBranch: "main" },
      advisory: { findings: [] },
      getChangedFiles: async () => [{ path: "README.md", status: "modified" }], // not a registry submission → surface defers (null)
    });
    expect(out).toBe(generic);
  });

  it("routes an unresolved/thrown manifest load to the allowlist default rather than throwing (fail-safe)", async () => {
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const throwingLoader = (): Promise<FocusManifest> => Promise.reject(new Error("simulated D1/network failure"));
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      REPO,
      true,
      generic,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory: { findings: [] },
        getChangedFiles: async () => [{ path: "README.md", status: "modified" }], // not a registry submission → surface defers (null)
      },
      throwingLoader,
    );
    expect(out).toBe(generic); // degrades to the allowlist-default resolution path, never throws
  });

  it("REGRESSION (#confirmed-bug): holds the gate NEUTRAL — rather than silently passing — when a NON-allowlisted repo's manifest fails to load, since that's the only way it could have configured a contentLane", async () => {
    // OTHER_REPO is NOT in LOOPOVER_REVIEW_REPOS, so its only path to a resolved spec is an explicit
    // contentLane: config in its OWN .loopover.yml. If we can't even read that file, we cannot tell "this
    // repo never configured content-lane" apart from "it did, but we couldn't check this pass" — silently
    // falling through to the plain generic (clean) evaluation would let a real registry submission merge
    // unevaluated.
    const OTHER_REPO = "SomeoneElse/other-registry";
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const throwingLoader = (): Promise<FocusManifest> => Promise.reject(new Error("simulated D1/network failure"));
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      OTHER_REPO,
      true,
      generic,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory: { findings: [] },
        getChangedFiles: async () => {
          throw new Error("getChangedFiles must NOT be called — held before any surface-lane fetch");
        },
      },
      throwingLoader,
    );
    expect(out?.conclusion).toBe("neutral");
    expect(out?.blockers).toEqual([]);
    expect(out?.title).toMatch(/held for human review/i);
  });

  it("REGRESSION (#confirmed-bug): the neutral hold has empty warnings when there was no generic gate evaluation at all", async () => {
    const OTHER_REPO = "SomeoneElse/other-registry";
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const throwingLoader = (): Promise<FocusManifest> => Promise.reject(new Error("simulated D1/network failure"));
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      OTHER_REPO,
      true,
      undefined, // no generic gate evaluation to fall back to for warnings
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory: { findings: [] },
        getChangedFiles: async () => {
          throw new Error("getChangedFiles must NOT be called — held before any surface-lane fetch");
        },
      },
      throwingLoader,
    );
    expect(out?.conclusion).toBe("neutral");
    expect(out?.warnings).toEqual([]);
  });

  it("REGRESSION (#confirmed-bug): a real generic hard blocker survives a NON-allowlisted repo's manifest-load failure — never cleared to neutral", async () => {
    const OTHER_REPO = "SomeoneElse/other-registry";
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked" };
    const genericWithBlocker = gate({ conclusion: "failure", blockers: [secret], warnings: [] });
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const throwingLoader = (): Promise<FocusManifest> => Promise.reject(new Error("simulated D1/network failure"));
    const out = await evaluateWithSurfaceLane(
      wiredEnv,
      OTHER_REPO,
      true,
      genericWithBlocker,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory: { findings: [] },
        getChangedFiles: async () => {
          throw new Error("getChangedFiles must NOT be called — held before any surface-lane fetch");
        },
      },
      throwingLoader,
    );
    expect(out).toBe(genericWithBlocker); // the real hard blocker is preserved, not overridden to neutral
  });

  it("activates the surface lane for a NON-metagraphed repo purely from an explicit contentLane: config — no allowlist entry needed", async () => {
    const OTHER_REPO = "SomeoneElse/other-registry";
    const OTHER_ENTRY = "registry/items/foo.json";
    const otherDoc = (items: unknown[]) => JSON.stringify({ items });
    const bodies: Record<string, string> = {
      [`HEAD:${OTHER_ENTRY}`]: otherDoc([{ url: "https://api.example.org/new" }]),
      [`BASE:${OTHER_ENTRY}`]: otherDoc([]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    // Flag on, but OTHER_REPO is NOT in LOOPOVER_REVIEW_REPOS — proving activation comes from the config alone.
    const configuredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const configuredManifest = (): Promise<FocusManifest> =>
      Promise.resolve(
        parseFocusManifest({
          contentLane: { entryFileGlob: "registry/items/*.json", collectionField: "items" },
        }),
      );
    const out = await evaluateWithSurfaceLane(
      configuredEnv,
      OTHER_REPO,
      true,
      undefined,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory: { findings: [] },
        getChangedFiles: async () => [{ path: OTHER_ENTRY, status: "modified" }],
      },
      configuredManifest,
    );
    // No validatorId was configured → structural gating only (a valid, non-duplicate, in-scope append) →
    // manual, NOT merge/close — the concrete proof this is reachable via config alone (see spec-resolver tests
    // for the full config→spec resolution matrix).
    expect(out?.conclusion).toBe("neutral");
  });

  it("a CONFIG-RESOLVED spec's duplicateKeyFields drives the same end-to-end dedup close as METAGRAPHED_LANE_SPEC's own — the whole pipeline, not just the code-defined default spec", async () => {
    const OTHER_REPO = "SomeoneElse/other-registry";
    const OTHER_ENTRY = "registry/items/foo.json";
    const otherDoc = (items: unknown[]) => JSON.stringify({ items });
    const dup1 = { url: "https://api.example.org/new" };
    const dup2 = { url: "https://api.example.org/new", note: "a same-PR resubmission of the same url" };
    const bodies: Record<string, string> = {
      [`HEAD:${OTHER_ENTRY}`]: otherDoc([dup1, dup2]),
      [`BASE:${OTHER_ENTRY}`]: otherDoc([]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    const configuredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const configuredManifest = (): Promise<FocusManifest> =>
      Promise.resolve(
        parseFocusManifest({
          contentLane: { entryFileGlob: "registry/items/*.json", collectionField: "items", duplicateKeyFields: ["url"] },
        }),
      );
    const advisory = { findings: [] as AdvisoryFinding[] };
    const out = await evaluateWithSurfaceLane(
      configuredEnv,
      OTHER_REPO,
      true,
      undefined,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: OTHER_ENTRY, status: "modified" }],
      },
      configuredManifest,
    );
    expect(out?.conclusion).toBe("failure"); // the same-PR url duplicate closes, exactly as the METAGRAPHED_LANE_SPEC regression test above proves
    expect(advisory.findings.map((f) => f.code)).toEqual(["surface_lane_reject"]);
  });

  it("an UNREGISTERED contentLane.validatorId (operator typo) pushes a non-blocking diagnostic finding into advisory.findings, alongside the degraded structural-only verdict", async () => {
    const OTHER_REPO = "SomeoneElse/other-registry";
    const OTHER_ENTRY = "registry/items/foo.json";
    const otherDoc = (items: unknown[]) => JSON.stringify({ items });
    const bodies: Record<string, string> = {
      [`HEAD:${OTHER_ENTRY}`]: otherDoc([{ url: "https://api.example.org/new" }]),
      [`BASE:${OTHER_ENTRY}`]: otherDoc([]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const m = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
      if (!m) return new Response("nope", { status: 404 });
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      const body = bodies[`${decodeURIComponent(m[2]!)}:${path}`];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    const configuredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    const configuredManifest = (): Promise<FocusManifest> =>
      Promise.resolve(
        parseFocusManifest({
          contentLane: { entryFileGlob: "registry/items/*.json", collectionField: "items", validatorId: "metagraph" }, // typo — should be "metagraphed"
        }),
      );
    const advisory = { findings: [] as AdvisoryFinding[] };
    const out = await evaluateWithSurfaceLane(
      configuredEnv,
      OTHER_REPO,
      true,
      undefined,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: OTHER_ENTRY, status: "modified" }],
      },
      configuredManifest,
    );
    // Structural gating still runs in degraded (no-validator) mode — a clean, non-duplicate, in-scope append →
    // manual (the same "no validator configured" degraded verdict an omitted validatorId gets), NOT a crash.
    expect(out?.conclusion).toBe("neutral");
    const codes = advisory.findings.map((f) => f.code);
    expect(codes).toContain("surface_lane_unknown_validator_id");
    const warning = advisory.findings.find((f) => f.code === "surface_lane_unknown_validator_id");
    expect(warning?.severity).toBe("warning");
    expect(warning?.detail).toContain('"metagraph"');
    expect(warning?.detail).toContain("metagraphed"); // the known-id hint names the real registered id
  });

  it("a REGISTERED contentLane.validatorId pushes NO unknown-validator diagnostic", async () => {
    const advisory = { findings: [] as AdvisoryFinding[] };
    const registeredManifest = (): Promise<FocusManifest> =>
      Promise.resolve(parseFocusManifest({ contentLane: { entryFileGlob: "registry/subnets/*.json", collectionField: "surfaces", validatorId: "metagraphed" } }));
    const configuredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: "Some/OtherRepo" } as unknown as Env;
    await evaluateWithSurfaceLane(
      configuredEnv,
      REPO,
      true,
      generic,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: "README.md", status: "modified" }], // not a submission → surface defers
      },
      registeredManifest,
    );
    expect(advisory.findings.map((f) => f.code)).not.toContain("surface_lane_unknown_validator_id");
  });

  it("an omitted validatorId (today's zero-config default) pushes NO unknown-validator diagnostic", async () => {
    const advisory = { findings: [] as AdvisoryFinding[] };
    const wiredEnv = { LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO } as unknown as Env;
    await evaluateWithSurfaceLane(
      wiredEnv,
      REPO,
      true,
      generic,
      {
        installationId: null,
        pr: { headSha: "HEAD", baseRef: "BASE" },
        repo: { defaultBranch: "main" },
        advisory,
        getChangedFiles: async () => [{ path: "README.md", status: "modified" }],
      },
      noConfigManifest,
    );
    expect(advisory.findings).toEqual([]);
  });
});
