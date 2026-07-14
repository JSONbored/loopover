import { describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  assessIdeaFeasibility,
  deriveIdeaIssueStatus,
} from "../../packages/loopover-miner/lib/idea-feasibility.js";
import type { ResolvedIdeaSignals } from "../../packages/loopover-miner/lib/idea-feasibility.js";
import type { FeasibilityGateResult } from "@loopover/engine";

function cleanSignals(overrides: Partial<ResolvedIdeaSignals> = {}): ResolvedIdeaSignals {
  return { targetResolvable: true, claimStatus: "unclaimed", duplicateClusterRisk: "none", ...overrides };
}

describe("deriveIdeaIssueStatus (#5671)", () => {
  it("returns 'missing' when the idea's target repo does not resolve (out of the loop's scope)", () => {
    expect(deriveIdeaIssueStatus({ acceptanceHints: ["retries on 5xx"] }, { targetResolvable: false })).toBe("missing");
  });

  it("returns 'invalid' when the idea declares NO objective success signal (acceptanceHints absent)", () => {
    expect(deriveIdeaIssueStatus({}, { targetResolvable: true })).toBe("invalid");
  });

  it("returns 'invalid' when acceptanceHints is present but empty (still nothing testable)", () => {
    expect(deriveIdeaIssueStatus({ acceptanceHints: [] }, { targetResolvable: true })).toBe("invalid");
  });

  it("returns 'ready' when the idea resolves and carries at least one objective success signal", () => {
    expect(deriveIdeaIssueStatus({ acceptanceHints: ["uploads retry on 5xx"] }, { targetResolvable: true })).toBe("ready");
  });
});

describe("assessIdeaFeasibility (#5671)", () => {
  it("a feasible idea (resolvable target, objective signal, clean metadata) proceeds to compute", () => {
    const result = assessIdeaFeasibility({ acceptanceHints: ["uploads retry on 5xx"] }, cleanSignals());
    expect(result.disposition).toBe("proceed");
    expect(result.verdict).toBe("go");
    expect(result.issueStatus).toBe("ready");
    expect(result.reasons).toEqual([]);
  });

  it("a well-formed but impossible-to-evaluate idea (no objective signal) is REJECTED before compute", () => {
    const result = assessIdeaFeasibility({ title: "make it better", acceptanceHints: [] }, cleanSignals());
    expect(result.disposition).toBe("reject");
    expect(result.verdict).toBe("avoid");
    expect(result.issueStatus).toBe("invalid");
    expect(result.reasons).toContain("issue_lifecycle_invalid");
  });

  it("an ambiguous idea (evaluable but overlaps existing work) is FLAGGED, not auto-proceeded or rejected", () => {
    const result = assessIdeaFeasibility(
      { acceptanceHints: ["adds an API key store"] },
      cleanSignals({ duplicateClusterRisk: "medium" }),
    );
    expect(result.disposition).toBe("flag");
    expect(result.verdict).toBe("raise");
    expect(result.reasons).toContain("duplicate_cluster_medium");
  });

  it("an out-of-scope idea whose target repo does not resolve is flagged (target_not_found)", () => {
    const result = assessIdeaFeasibility(
      { acceptanceHints: ["do a thing"] },
      cleanSignals({ targetResolvable: false }),
    );
    expect(result.disposition).toBe("flag");
    expect(result.verdict).toBe("raise");
    expect(result.issueStatus).toBe("missing");
    expect(result.reasons).toEqual(expect.arrayContaining(["target_not_found"]));
  });

  it("surfaces multiple avoid reasons together (already-solved AND duplicate cluster)", () => {
    const result = assessIdeaFeasibility(
      { acceptanceHints: ["x"] },
      cleanSignals({ claimStatus: "solved", duplicateClusterRisk: "high" }),
    );
    expect(result.disposition).toBe("reject");
    expect(result.reasons).toEqual(expect.arrayContaining(["claim_status_solved", "duplicate_cluster_high"]));
  });

  it("uses an injected verdict composer when provided (test seam), not the engine default", () => {
    const spy = vi.fn((): FeasibilityGateResult => ({ verdict: "go", avoidReasons: [], raiseReasons: [], summary: "injected" }));
    const result = assessIdeaFeasibility(
      { acceptanceHints: ["x"] },
      cleanSignals(),
      { buildFeasibilityVerdict: spy },
    );
    expect(spy).toHaveBeenCalledWith({
      found: true,
      claimStatus: "unclaimed",
      duplicateClusterRisk: "none",
      issueStatus: "ready",
    });
    expect(result.disposition).toBe("proceed");
    expect(result.summary).toBe("injected");
  });
});
