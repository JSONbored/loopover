// Locks advisory==live computed disposition parity (#2190). Advisory mode posts the non-enforcing
// conclusion while dry-run exposes the byte-identical would-be verdict that live enforcement applies.
import { describe, expect, it, vi } from "vitest";
import { evaluateGateCheck, type GateCheckConclusion, type GateCheckPolicy } from "../../src/rules/advisory";
import { planAgentMaintenanceActions, type AgentActionPlanInput } from "../../src/settings/agent-actions";
import type { Advisory } from "../../src/types";

function missingIssueAdvisory(): Advisory {
  return {
    id: "advisory-live-parity",
    targetType: "pull_request",
    targetKey: "owner/repo#7",
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "sha7",
    conclusion: "neutral",
    severity: "warning",
    title: "LoopOver advisory available",
    summary: "1 advisory finding generated.",
    findings: [
      {
        code: "missing_linked_issue",
        title: "No linked issue detected",
        severity: "warning",
        detail: "No closing reference.",
        action: "Link the issue.",
      },
    ],
    generatedAt: "2026-06-13T00:00:00.000Z",
  };
}

function cleanPass(): Advisory {
  return { ...missingIssueAdvisory(), findings: [] };
}

function aiFail(): Advisory {
  return {
    ...missingIssueAdvisory(),
    findings: [
      {
        code: "ai_consensus_defect",
        title: "AI consensus defect",
        severity: "warning",
        detail: "both models flagged a real defect",
        action: "fix it",
      },
    ],
  };
}

function advisoryWouldBeConclusion(advisory: Advisory, policy: GateCheckPolicy): GateCheckConclusion {
  const out = evaluateGateCheck(advisory, { ...policy, dryRun: true });
  expect(out.displayConclusion).toBeDefined();
  return out.displayConclusion!;
}

function liveConclusion(advisory: Advisory, policy: GateCheckPolicy): GateCheckConclusion {
  return evaluateGateCheck(advisory, policy).conclusion;
}

function agentInput(overrides: Partial<AgentActionPlanInput> & { conclusion: GateCheckConclusion }): AgentActionPlanInput {
  return {
    blockerTitles: [],
    autonomy: {},
    autoMaintain: { requireApprovals: 0, mergeMethod: "squash" },
    slopGateMinScore: 60,
    changedPaths: [],
    hardGuardrailGlobs: [],
    authorIsOwner: false,
    authorIsAdmin: false,
    authorIsAutomationBot: false,
    ciState: "passed",
    pr: { labels: [], mergeableState: "clean", headSha: "head" },
    ...overrides,
  };
}

const terminalClass = (actions: ReturnType<typeof planAgentMaintenanceActions>) =>
  actions.find((action) => action.actionClass === "merge" || action.actionClass === "close")?.actionClass ?? "hold";

describe("advisory==live gate disposition parity (#2190)", () => {
  const advisoryModes: GateCheckPolicy = { aiReviewGateMode: "advisory", linkedIssueGateMode: "advisory" };
  const liveModes: GateCheckPolicy = { aiReviewGateMode: "block", linkedIssueGateMode: "block" };

  it("PASS: clean PR would-be verdict matches live enforcement", () => {
    const advisory = cleanPass();
    expect(advisoryWouldBeConclusion(advisory, advisoryModes)).toBe(liveConclusion(advisory, liveModes));
    expect(liveConclusion(advisory, liveModes)).toBe("success");
  });

  it("FAIL: AI consensus defect would-be close matches live enforcement", () => {
    const advisory = aiFail();
    expect(advisoryWouldBeConclusion(advisory, advisoryModes)).toBe(liveConclusion(advisory, liveModes));
    expect(liveConclusion(advisory, liveModes)).toBe("failure");
  });

  it("advisory mode posts a non-blocking conclusion while dry-run exposes the would-be verdict", () => {
    const out = evaluateGateCheck(aiFail(), { ...advisoryModes, dryRun: true });
    expect(out.conclusion).toBe("success");
    expect(out.displayConclusion).toBe("failure");
  });
});

describe("advisory==live execution boundary (#2190)", () => {
  it("only live autonomy schedules terminal merge/close actions for the same verdict", () => {
    const executeTerminal = vi.fn();
    const cases = [
      {
        title: "passing PR",
        expected: "merge" as const,
        facts: agentInput({
          conclusion: "success",
          pr: { labels: [], mergeableState: "clean", headSha: "pass-head" },
        }),
        liveAutonomy: { merge: "auto" as const },
      },
      {
        title: "failing PR",
        expected: "close" as const,
        facts: agentInput({
          conclusion: "failure",
          blockerTitles: ["review gate failed"],
          pr: { labels: [], headSha: "fail-head" },
        }),
        liveAutonomy: { close: "auto" as const },
      },
    ];

    for (const { title, expected, facts, liveAutonomy } of cases) {
      const livePlan = planAgentMaintenanceActions({ ...facts, autonomy: liveAutonomy });
      const advisoryPlan = planAgentMaintenanceActions({ ...facts, autonomy: {} });

      expect(terminalClass(livePlan), title).toBe(expected);
      expect(terminalClass(advisoryPlan), title).toBe("hold");
      expect(advisoryPlan.some((action) => action.actionClass === "merge" || action.actionClass === "close"), title).toBe(
        false,
      );

      for (const action of livePlan.filter((candidate) => candidate.actionClass === expected)) {
        executeTerminal(action);
      }
    }

    expect(executeTerminal).toHaveBeenCalledTimes(cases.length);
    expect(executeTerminal.mock.calls.map(([action]) => action.actionClass)).toEqual(["merge", "close"]);
  });
});
