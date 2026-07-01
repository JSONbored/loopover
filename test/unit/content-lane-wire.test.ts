import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_JUDGMENT_BLOCKER_CODES, type GateCheckEvaluation } from "../../src/rules/advisory";
import { applySurfaceGate, evaluateWithSurfaceLane, isContentLaneWired, resolveSurfaceRefs, runMetagraphedSurfaceGate, surfaceVerdictToGate } from "../../src/review/content-lane-wire";
import type { SurfaceReviewInput } from "../../src/review/content-lane/orchestrator";
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

afterEach(() => vi.unstubAllGlobals());

describe("isContentLaneWired", () => {
  it("requires BOTH the flag and the per-repo allowlist", () => {
    expect(isContentLaneWired({ GITTENSORY_REVIEW_REPOS: REPO }, REPO)).toBe(false); // flag off
    expect(isContentLaneWired({ GITTENSORY_REVIEW_CONTENT_LANE: "true", GITTENSORY_REVIEW_REPOS: "OtherOrg/other" }, REPO)).toBe(false); // not allowlisted
    expect(isContentLaneWired({ GITTENSORY_REVIEW_CONTENT_LANE: "true", GITTENSORY_REVIEW_REPOS: REPO }, REPO)).toBe(true);
  });
});

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
      title: "Gittensory Orb Review Agent — held for manual review",
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
  it("a MIXED generic failure (an AI-judgment code plus a real blocker) is not AI-judgment-only — still overrides a surface merge", () => {
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked key" };
    const aiConsensusDefect: AdvisoryFinding = { code: "ai_consensus_defect", title: "AI defect", severity: "critical", detail: "" };
    const genericMixed = gate({ conclusion: "failure", blockers: [aiConsensusDefect, secret], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(genericMixed, surfaceMerge);
    expect(out?.conclusion).toBe("failure"); // the real blocker means this is NOT an AI-judgment-only failure
    expect(out?.blockers).toEqual([aiConsensusDefect, secret]);
  });
});

describe("runMetagraphedSurfaceGate (injected loader — adapter logic)", () => {
  const run = (files: { path: string; status?: string | null }[], stub: Record<string, string | null>, advisory = { findings: [] as AdvisoryFinding[] }) =>
    runMetagraphedSurfaceGate(env, { installationId: 0, repoFullName: REPO, pr: { headSha: "HEAD", baseRef: "BASE" }, advisory, files }, loader(stub));

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
    expect(await evaluateWithSurfaceLane({ GITTENSORY_REVIEW_CONTENT_LANE: "true", GITTENSORY_REVIEW_REPOS: REPO } as unknown as Env, REPO, false, generic, baseArgs)).toBe(generic);
  });

  it("returns the generic gate unchanged when the lane is not wired (no file resolve)", async () => {
    expect(await evaluateWithSurfaceLane({} as unknown as Env, REPO, true, generic, baseArgs)).toBe(generic);
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
    const wiredEnv = { GITTENSORY_REVIEW_CONTENT_LANE: "true", GITTENSORY_REVIEW_REPOS: REPO } as unknown as Env;
    const out = await evaluateWithSurfaceLane(wiredEnv, REPO, true, generic, {
      installationId: null, // → unauthenticated fetcher; only the stub is hit
      pr: { headSha: "HEAD", baseRef: "BASE" },
      repo: { defaultBranch: "main" },
      advisory: { findings: [] },
      getChangedFiles: async () => [{ path: SUBNET, status: "modified" }],
    });
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
    const wiredEnv = { GITTENSORY_REVIEW_CONTENT_LANE: "true", GITTENSORY_REVIEW_REPOS: REPO } as unknown as Env;
    const out = await evaluateWithSurfaceLane(wiredEnv, REPO, true, genericAiOnly, {
      installationId: null,
      pr: { headSha: "HEAD", baseRef: "BASE" },
      repo: { defaultBranch: "main" },
      advisory,
      getChangedFiles: async () => [{ path: SUBNET, status: "modified" }],
    });
    expect(out?.conclusion).toBe("success");
    // The overridden ai_consensus_defect must be gone from advisory.findings too — otherwise the unified-comment
    // bridge would still recover it via consensusDefectFromFindings and render "Concerns raised" over a merge.
    expect(advisory.findings).toEqual([otherWarning]);
  });

  it("does NOT touch advisory.findings when the surface lane defers or the generic gate isn't AI-judgment-only", async () => {
    const aiConsensusDefect: AdvisoryFinding = { code: "ai_consensus_defect", title: "AI defect", severity: "critical", detail: "" };
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked" };
    const advisory = { findings: [aiConsensusDefect, secret] };
    // A real (non-AI) blocker alongside the AI one means isAiJudgmentOnlyFailure is false — no cleanup should run.
    const genericMixed = gate({ conclusion: "failure", blockers: [aiConsensusDefect, secret], warnings: [] });
    const wiredEnv = { GITTENSORY_REVIEW_CONTENT_LANE: "true", GITTENSORY_REVIEW_REPOS: REPO } as unknown as Env;
    await evaluateWithSurfaceLane(wiredEnv, REPO, true, genericMixed, {
      installationId: null,
      pr: { headSha: "HEAD", baseRef: "BASE" },
      repo: { defaultBranch: "main" },
      advisory,
      getChangedFiles: async () => [{ path: "README.md", status: "modified" }], // not a registry submission → surface defers (null)
    });
    expect(advisory.findings).toEqual([aiConsensusDefect, secret]);
  });
});
