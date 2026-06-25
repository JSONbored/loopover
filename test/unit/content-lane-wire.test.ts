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
    // Regression guard: a deterministic surface close must never be refutable by green CI.
    expect(AI_JUDGMENT_BLOCKER_CODES.has(evaluation.blockers[0]!.code)).toBe(false);
  });

  it("manual → action_required with a warning (not auto-closed)", () => {
    const { evaluation, finding } = surfaceVerdictToGate({ verdict: "manual", summary: "auth declared" });
    expect(evaluation.conclusion).toBe("action_required");
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
  it("PRESERVES a generic hard blocker over a surface merge (a committed secret can never merge)", () => {
    const secret: AdvisoryFinding = { code: "secret_leak", title: "Secret", severity: "critical", detail: "leaked key" };
    const generic = gate({ conclusion: "failure", blockers: [secret], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    const out = applySurfaceGate(generic, surfaceMerge);
    expect(out?.conclusion).toBe("failure"); // the secret still blocks the merge
    expect(out?.blockers).toEqual([secret]); // the generic blocker survives the override
  });
  it("preserves a generic neutral hold over a surface merge", () => {
    const generic = gate({ conclusion: "neutral", title: "First-contribution grace", blockers: [], warnings: [] });
    const surfaceMerge = gate({ conclusion: "success", title: "Surface", summary: "valid entry" });
    expect(applySurfaceGate(generic, surfaceMerge)).toBe(generic);
  });
  it("lets a surface rejection override a generic neutral hold", () => {
    const generic = gate({ conclusion: "neutral", title: "First-contribution grace", blockers: [], warnings: [] });
    expect(applySurfaceGate(generic, surfaceClose)).toBe(surfaceClose);
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
});
