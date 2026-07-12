import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  buildCodingTaskAcceptanceCriteria,
  buildCodingTaskFeasibility,
  buildCodingTaskSpec,
  writeAcceptanceCriteriaFile,
} from "../../packages/gittensory-miner/lib/coding-task-spec.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-coding-task-spec-"));
  roots.push(root);
  return root;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    repoFullName: "acme/widgets",
    number: 7,
    title: "Uploads should retry on 5xx",
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    htmlUrl: null,
    body: "Uploads fail silently on transient errors.",
    createdAt: null,
    updatedAt: null,
    closedAt: null,
    labels: ["bug"],
    linkedPrs: [],
    ...overrides,
  };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    repoFullName: "acme/widgets",
    number: 42,
    title: "Unrelated docs fix",
    state: "open",
    authorLogin: "someone-else",
    authorAssociation: "NONE",
    headSha: null,
    headRef: null,
    baseRef: "main",
    htmlUrl: null,
    mergedAt: null,
    isDraft: false,
    mergeableState: "clean",
    reviewDecision: null,
    body: "",
    createdAt: null,
    updatedAt: null,
    closedAt: null,
    labels: [],
    linkedIssues: [],
    ...overrides,
  };
}

function claimLedger(activeClaims: Array<{ issueNumber: number }> = []) {
  return { listClaims: () => activeClaims };
}

describe("buildCodingTaskFeasibility (#5132)", () => {
  it("returns go for an unclaimed, un-clustered, present issue", () => {
    const context = { issues: [issue()], pullRequests: [] };
    const result = buildCodingTaskFeasibility("acme/widgets", issue(), context, claimLedger());
    expect(result.verdict).toBe("go");
    expect(result.avoidReasons).toEqual([]);
    expect(result.raiseReasons).toEqual([]);
  });

  it("returns raise with claim_status_claimed when another active claim exists on the target issue", () => {
    const context = { issues: [issue()], pullRequests: [] };
    const result = buildCodingTaskFeasibility("acme/widgets", issue(), context, claimLedger([{ issueNumber: 7 }]));
    expect(result.verdict).toBe("raise");
    expect(result.raiseReasons).toContain("claim_status_claimed");
  });

  it("returns avoid with duplicate_cluster_high when the issue already sits in a high-risk cluster (one legitimately-closing PR is enough to trigger this, unlike #5145's stricter check)", () => {
    const context = { issues: [issue()], pullRequests: [pr({ body: "Closes #7", linkedIssues: [7] })] };
    const result = buildCodingTaskFeasibility("acme/widgets", issue(), context, claimLedger());
    expect(result.verdict).toBe("avoid");
    expect(result.avoidReasons).toContain("duplicate_cluster_high");
  });

  it("returns raise with target_not_found when the issue isn't present in the fetched context", () => {
    const context = { issues: [], pullRequests: [] };
    const result = buildCodingTaskFeasibility("acme/widgets", issue(), context, claimLedger());
    expect(result.verdict).toBe("raise");
    expect(result.raiseReasons).toContain("target_not_found");
  });

  it("defaults issueStatus to ready (no fabricated quality data, matching feasibilityInputFromPreStartCheck's own documented default)", () => {
    const context = { issues: [issue()], pullRequests: [] };
    const result = buildCodingTaskFeasibility("acme/widgets", issue(), context, claimLedger());
    // A "ready" issueStatus contributes no avoid/raise reason at all -- confirmed by the clean go verdict above
    // with zero reasons, since none of the other collect* functions fire for issueStatus === "ready".
    expect(result.avoidReasons.some((reason) => reason.includes("issue"))).toBe(false);
    expect(result.raiseReasons.some((reason) => reason.includes("issue_quality") || reason.includes("issue_missing"))).toBe(false);
  });
});

describe("buildCodingTaskAcceptanceCriteria (#5132)", () => {
  it("composes a go document with sanitized text fields", () => {
    const feasibility = buildCodingTaskFeasibility("acme/widgets", issue(), { issues: [issue()], pullRequests: [] }, claimLedger());
    const doc = buildCodingTaskAcceptanceCriteria(issue(), feasibility);
    expect(doc.verdict).toBe("go");
    expect(doc.writable).toBe(true);
    expect(doc.taskBrief).toContain("Uploads should retry on 5xx");
    expect(doc.taskBrief).toContain("Uploads fail silently on transient errors.");
    expect(doc.constraints).toBe("Labels on this issue: bug.");
  });

  it("scrubs unsafe economic/identity terms from the issue body via the shared sanitizer", () => {
    const withUnsafeTerm = issue({ body: "This issue affects the miner's reward calculation." });
    const feasibility = buildCodingTaskFeasibility("acme/widgets", withUnsafeTerm, { issues: [withUnsafeTerm], pullRequests: [] }, claimLedger());
    const doc = buildCodingTaskAcceptanceCriteria(withUnsafeTerm, feasibility);
    expect(doc.taskBrief).not.toContain("reward");
    expect(doc.taskBrief).toContain("[redacted]");
  });

  it("produces empty constraints when the issue has no labels", () => {
    const noLabels = issue({ labels: [] });
    const feasibility = buildCodingTaskFeasibility("acme/widgets", noLabels, { issues: [noLabels], pullRequests: [] }, claimLedger());
    const doc = buildCodingTaskAcceptanceCriteria(noLabels, feasibility);
    expect(doc.constraints).toBe("");
  });

  it("marks a raise/avoid verdict document as not writable", () => {
    const feasibility = buildCodingTaskFeasibility("acme/widgets", issue(), { issues: [], pullRequests: [] }, claimLedger());
    const doc = buildCodingTaskAcceptanceCriteria(issue(), feasibility);
    expect(doc.verdict).toBe("raise");
    expect(doc.writable).toBe(false);
  });
});

describe("writeAcceptanceCriteriaFile (#5132)", () => {
  it("writes the file only when the document's verdict is go", () => {
    const dir = tempDir();
    const feasibility = buildCodingTaskFeasibility("acme/widgets", issue(), { issues: [issue()], pullRequests: [] }, claimLedger());
    const doc = buildCodingTaskAcceptanceCriteria(issue(), feasibility);

    const result = writeAcceptanceCriteriaFile(dir, doc);
    expect(result.written).toBe(true);
    expect(result.path).toBe(join(dir, "acceptance-criteria.json"));
    const parsed = JSON.parse(readFileSync(result.path!, "utf8"));
    expect(parsed.verdict).toBe("go");
    expect(parsed.taskBrief).toContain("Uploads should retry on 5xx");
  });

  it("does not write anything for a raise/avoid verdict document", () => {
    const dir = tempDir();
    const feasibility = buildCodingTaskFeasibility("acme/widgets", issue(), { issues: [], pullRequests: [] }, claimLedger());
    const doc = buildCodingTaskAcceptanceCriteria(issue(), feasibility);

    const result = writeAcceptanceCriteriaFile(dir, doc);
    expect(result).toEqual({ written: false, path: null });
  });
});

describe("buildCodingTaskSpec (#5132)", () => {
  it("REGRESSION: assembles a real, ready spec for a legitimate go verdict", () => {
    const dir = tempDir();
    const target = issue();
    const result = buildCodingTaskSpec({
      repoFullName: "acme/widgets",
      issue: target,
      context: { issues: [target], pullRequests: [] },
      claimLedger: claimLedger(),
      workingDirectory: dir,
    });

    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error("expected ready");
    expect(result.verdict).toBe("go");
    expect(result.acceptanceCriteriaPath).toBe(join(dir, "acceptance-criteria.json"));
    expect(result.instructions).toContain("#7 -- Uploads should retry on 5xx");
    expect(result.instructions).toContain(result.acceptanceCriteriaPath);
    expect(result.title).toBe("Uploads should retry on 5xx");
    expect(result.body).toBe("Uploads fail silently on transient errors.");
    expect(result.labels).toEqual(["bug"]);
    expect(result.linkedIssues).toEqual([7]);
    // The file genuinely landed on disk -- not just returned in memory.
    expect(JSON.parse(readFileSync(result.acceptanceCriteriaPath, "utf8")).writable).toBe(true);
  });

  it("returns ready:false and writes nothing when the verdict is raise/avoid", () => {
    const dir = tempDir();
    const target = issue();
    const result = buildCodingTaskSpec({
      repoFullName: "acme/widgets",
      issue: target,
      context: { issues: [], pullRequests: [] },
      claimLedger: claimLedger(),
      workingDirectory: dir,
    });

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected not ready");
    expect(result.verdict).toBe("raise");
    expect(result.feasibility.raiseReasons).toContain("target_not_found");
    expect(() => readFileSync(join(dir, "acceptance-criteria.json"), "utf8")).toThrow();
  });

  it("omits body from the result when the issue has no body", () => {
    const dir = tempDir();
    const target = issue({ body: null });
    const result = buildCodingTaskSpec({
      repoFullName: "acme/widgets",
      issue: target,
      context: { issues: [target], pullRequests: [] },
      claimLedger: claimLedger(),
      workingDirectory: dir,
    });
    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error("expected ready");
    expect(result.body).toBeUndefined();
  });
});
