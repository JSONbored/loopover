import { describe, expect, it } from "vitest";

import {
  buildRegistrationOwnerWorkflow,
  buildRegistrationWorkspaceView,
  collectRegistrationOwnerWorkflowPublicText,
  collectRegistrationWorkspacePublicText,
  isRegistrationWorkspacePublicSafe,
  resolveRegistrationWorkspaceFreshness,
  sanitizeRegistrationWorkspaceText,
  splitRepoFullName,
  type GittensorConfigRecommendationPayload,
  type RegistrationReadinessPayload,
} from "../../apps/gittensory-ui/src/lib/registration-workspace";

const FORBIDDEN =
  /wallet|hotkey|raw trust score|payout|reward|farming|private reviewability|reviewability|public score estimate/i;

function readyFixture(overrides: Partial<RegistrationReadinessPayload> = {}): RegistrationReadinessPayload {
  return {
    repoFullName: "JSONbored/gittensory",
    generatedAt: "2026-06-01T00:00:00.000Z",
    ready: true,
    recommendedRegistrationMode: "direct_pr",
    issuePolicy: "direct_pr_no_issue_required",
    directPrReadiness: { ready: true, reasons: ["Direct-PR intake is healthy."] },
    issueDiscoveryReadiness: {
      ready: false,
      recommendation: "not_recommended",
      reasons: ["Issue discovery should stay off until intake is excellent."],
    },
    labelPolicy: {
      autoLabelEnabled: true,
      label: "gittensor",
      trustedPipelineReady: true,
      missingOrUnusedRegistryLabels: [],
    },
    maintainerCutReadiness: {
      ready: true,
      summary: "Maintainer cut can be reviewed without blocking intake.",
      reasons: ["Queue burden is low."],
      warnings: [],
      recommendedAction: "consider_small_cut",
    },
    testCoverageHealth: {
      status: "gate_ready",
      trustedLabelPipelineReady: true,
      checkRunMode: "enabled",
      requiredGate: ["npm run test:ci"],
      note: "Use repo CI gates before widening contributor intake.",
      warnings: [],
    },
    queueHealth: {
      level: "low",
      burdenScore: 0.2,
      reviewablePullRequests: 3,
      summary: "Queue burden is low.",
    },
    contributorIntakeHealth: { level: "healthy", summary: "Contributor intake is healthy." },
    githubApp: {
      installed: true,
      publicSurface: "comment_and_label",
      commentMode: "detected_contributors_only",
      checkRunMode: "enabled",
      quietByDefault: true,
      behavior: "Quiet-by-default GitHub App assistance.",
      warnings: [],
    },
    policyReadiness: null,
    blockers: [],
    warnings: [],
    docsCompleteness: {
      status: "repo_docs_not_crawled",
      requiredDocs: ["CONTRIBUTING.md", "README.md"],
      note: "Gittensory validates public repo docs locally; remote crawl is not enabled yet.",
    },
    dataQuality: { status: "complete", partial: false, warnings: [] },
    ...overrides,
  };
}

function configFixture(): GittensorConfigRecommendationPayload {
  return {
    repoFullName: "JSONbored/gittensory",
    generatedAt: "2026-06-01T00:00:00.000Z",
    privateOnly: true,
    current: { maintainerCut: 0 },
    recommended: { participationMode: "direct_pr", maintainerCut: 0.3, issueDiscoveryShare: 0 },
    tradeoffs: [
      "Staying direct-PR-only keeps maintainer triage low but forgoes issue-discovery contributor flow.",
      "Introducing a maintainer cut rewards upkeep but reduces the share available to contributor miners.",
    ],
    reasons: ["Direct-PR mode is the safest default until issue-discovery intake is intentionally staffed."],
    warnings: [],
    dataQuality: { status: "complete", partial: false, warnings: [] },
  };
}

describe("registration workspace UI helpers", () => {
  it("ready fixture produces an advisory workspace view with separated lanes", () => {
    const view = buildRegistrationWorkspaceView(readyFixture(), configFixture());
    expect(view.summary.ready).toBe(true);
    expect(view.lanes.directPr.status).toBe("ready");
    expect(view.lanes.issueDiscovery.title).toMatch(/Issue discovery/i);
    expect(view.lanes.maintainerEconomics.title).toMatch(/Maintainer economics/i);
    expect(view.lanes.minerGuidance.title).toMatch(/Miner scoreability/i);
    expect(view.config?.tradeoffs.length).toBeGreaterThan(0);
    expect(view.advisoryBanner).toMatch(/Advisory/i);
  });

  it("not-ready fixture surfaces blockers and blocked summary status", () => {
    const view = buildRegistrationWorkspaceView(
      readyFixture({
        ready: false,
        blockers: ["Repository config quality needs attention before registration promotion."],
        directPrReadiness: { ready: false, reasons: ["Config quality is fragile."] },
      }),
      null,
    );
    expect(view.summary.ready).toBe(false);
    expect(view.summary.status).toBe("blocked");
    expect(view.summary.headline).toMatch(/Resolve blockers/i);
  });

  it("stale data fixture marks freshness degraded and keeps warnings", () => {
    const freshness = resolveRegistrationWorkspaceFreshness(
      { status: "degraded", partial: true, warnings: ["Burden forecast unavailable for JSONbored/gittensory."] },
      { status: "complete", partial: false, warnings: [] },
    );
    expect(freshness.status).toBe("degraded");
    expect(freshness.warnings[0]).toMatch(/Burden forecast unavailable/i);

    const view = buildRegistrationWorkspaceView(
      readyFixture({
        dataQuality: { status: "degraded", partial: true, warnings: freshness.warnings },
      }),
      configFixture(),
    );
    expect(view.freshness.status).toBe("degraded");
    expect(view.freshness.warnings.length).toBeGreaterThan(0);
  });

  it("public text hygiene regression drops forbidden language from workspace output", () => {
    const view = buildRegistrationWorkspaceView(
      readyFixture({
        warnings: ["wallet hotkey payout estimate should be removed"],
        directPrReadiness: { ready: true, reasons: ["Safe reason only."] },
      }),
      configFixture(),
    );
    const publicText = collectRegistrationWorkspacePublicText(view).join("\n");
    expect(publicText).not.toMatch(FORBIDDEN);
    expect(sanitizeRegistrationWorkspaceText("estimate your reward")).toBeNull();
    expect(isRegistrationWorkspacePublicSafe("Queue burden is low.")).toBe(true);
  });

  it("guided workflow groups readiness into five buckets with remediation", () => {
    const workflow = buildRegistrationOwnerWorkflow(readyFixture(), configFixture());
    expect(workflow.buckets.map((bucket) => bucket.id)).toEqual([
      "policy",
      "data_quality",
      "queue_health",
      "docs_onboarding",
      "maintainer_capacity",
    ]);
    const docs = workflow.buckets.find((bucket) => bucket.id === "docs_onboarding");
    expect(docs?.state).toBe("needs_cleanup");
    expect(docs?.items[0]?.remediationKind).toBe("manual");
    expect(workflow.overallState).toBe("needs_cleanup");
    expect(workflow.nextSteps.length).toBeGreaterThan(0);
  });

  it("blocked readiness maps workflow to not ready with concrete blocker remediation", () => {
    const workflow = buildRegistrationOwnerWorkflow(
      readyFixture({
        ready: false,
        blockers: ["Repository config quality needs attention before registration promotion."],
        directPrReadiness: { ready: false, reasons: ["Config quality is fragile."] },
        queueHealth: {
          level: "critical",
          burdenScore: 0.95,
          reviewablePullRequests: 40,
          summary: "Queue burden is critical.",
        },
      }),
      null,
    );
    expect(workflow.overallState).toBe("not_ready");
    expect(workflow.buckets.find((bucket) => bucket.id === "queue_health")?.state).toBe("not_ready");
    const policy = workflow.buckets.find((bucket) => bucket.id === "policy");
    expect(policy?.items.some((item) => item.title === "Registration blocker")).toBe(true);
    expect(collectRegistrationOwnerWorkflowPublicText(workflow).join(" ")).not.toMatch(FORBIDDEN);
  });

  it("accepted workflow when readiness is ready and buckets are clear", () => {
    const workflow = buildRegistrationOwnerWorkflow(
      readyFixture({
        docsCompleteness: {
          status: "verified",
          requiredDocs: ["CONTRIBUTING.md"],
          note: "Docs verified locally.",
        },
        testCoverageHealth: {
          status: "gate_ready",
          trustedLabelPipelineReady: true,
          checkRunMode: "enabled",
          requiredGate: ["npm run test:ci"],
          note: "Gates ready.",
          warnings: [],
        },
      }),
      configFixture(),
    );
    expect(workflow.overallState).toBe("accepted");
    expect(workflow.buckets.every((bucket) => bucket.state === "accepted")).toBe(true);
    const view = buildRegistrationWorkspaceView(
      readyFixture({
        ready: true,
        docsCompleteness: { status: "verified", requiredDocs: ["CONTRIBUTING.md"], note: "Docs verified locally." },
      }),
      configFixture(),
    );
    expect(view.workflow.overallState).toBe("accepted");
  });

  it("resolveRegistrationWorkspaceFreshness handles blocked, stale, and unknown paths", () => {
    expect(resolveRegistrationWorkspaceFreshness({ status: "blocked", partial: false, warnings: [] }).status).toBe(
      "stale",
    );
    expect(
      resolveRegistrationWorkspaceFreshness(
        { status: "degraded", partial: true, warnings: ["Signal drift detected."] },
        { status: "complete", partial: false, warnings: [] },
      ).status,
    ).toBe("degraded");
    expect(resolveRegistrationWorkspaceFreshness(undefined, undefined).status).toBe("unknown");
    expect(
      resolveRegistrationWorkspaceFreshness({ status: "unknown", partial: false, warnings: ["Refresh pending."] })
        .warnings,
    ).toEqual(["Refresh pending."]);
  });

  it("workspace view covers lane, operations, and policy-warning branches", () => {
    const view = buildRegistrationWorkspaceView(
      readyFixture({
        ready: false,
        blockers: [],
        directPrReadiness: { ready: false, reasons: ["Lane warming up."] },
        issueDiscoveryReadiness: {
          ready: true,
          recommendation: "preferred",
          reasons: ["Issue discovery is staffed."],
        },
        maintainerCutReadiness: {
          ready: false,
          reasons: [],
          warnings: ["Review maintainer cut."],
        },
        labelPolicy: {
          autoLabelEnabled: false,
          label: "custom",
          trustedPipelineReady: false,
          missingOrUnusedRegistryLabels: ["needs-triage"],
        },
        queueHealth: { level: "medium", burdenScore: 0.55, reviewablePullRequests: 12, summary: "Moderate queue." },
        testCoverageHealth: {
          status: "needs_attention",
          trustedLabelPipelineReady: false,
          checkRunMode: "disabled",
          requiredGate: [],
          note: "Gate not ready.",
          warnings: ["Missing required check."],
        },
        githubApp: {
          installed: false,
          publicSurface: "off",
          commentMode: "off",
          checkRunMode: "off",
          quietByDefault: false,
          behavior: "GitHub App not installed.",
          warnings: ["Install the app."],
        },
        policyReadiness: {
          summary: "Policy drift",
          publicWarnings: [
            {
              title: "Focus manifest drift",
              detail: "Manifest paths no longer match registry scope.",
              action: "Refresh focus manifest.",
              severity: "critical",
            },
            { title: "wallet", detail: "hotkey", action: "payout", severity: "warn" },
          ],
        },
      }),
      null,
    );
    expect(view.summary.status).toBe("warn");
    expect(view.lanes.issueDiscovery.status).toBe("ready");
    expect(view.lanes.maintainerEconomics.status).toBe("blocked");
    expect(view.operations.find((section) => section.id === "queue-health")?.status).toBe("warn");
    expect(view.operations.find((section) => section.id === "label-policy")?.bullets.join(" ")).toMatch(
      /not verified/i,
    );
    expect(view.policyWarnings).toHaveLength(1);
    expect(view.config).toBeNull();
  });

  it("routes blockers into workflow buckets and remediation helpers", () => {
    const workflow = buildRegistrationOwnerWorkflow(
      readyFixture({
        ready: false,
        blockers: [
          "Repository config quality needs attention before registration promotion.",
          "CONTRIBUTING.md onboarding doc is missing.",
          "Open pull request queue is overloaded.",
          "GitHub App installation is incomplete.",
          "Burden forecast drift requires refresh.",
          "Generic maintainer capacity blocker.",
          "wallet hotkey payout estimate",
        ],
        queueHealth: { level: "medium", burdenScore: 0.5, reviewablePullRequests: 8, summary: "Queue warming." },
        contributorIntakeHealth: { level: "strained", summary: "Intake is strained." },
        maintainerCutReadiness: {
          ready: false,
          summary: "Cut not ready.",
          reasons: [],
          warnings: [],
          recommendedAction: "hold_cut",
        },
        testCoverageHealth: {
          status: "needs_attention",
          trustedLabelPipelineReady: false,
          checkRunMode: "enabled",
          requiredGate: ["npm run test:ci"],
          note: "Validation incomplete.",
          warnings: ["Trusted label pipeline pending."],
        },
        dataQuality: { status: "stale", partial: true, warnings: ["Forecast stale."] },
        labelPolicy: {
          autoLabelEnabled: true,
          label: "gittensor",
          trustedPipelineReady: false,
          missingOrUnusedRegistryLabels: [],
        },
      }),
      configFixture(),
    );
    expect(workflow.overallState).toBe("not_ready");
    expect(workflow.buckets.find((bucket) => bucket.id === "policy")?.items.length).toBeGreaterThan(1);
    expect(
      workflow.buckets
        .find((bucket) => bucket.id === "docs_onboarding")
        ?.items.some((item) => /CONTRIBUTING|onboarding docs/i.test(item.remediation)),
    ).toBe(true);
    expect(workflow.buckets.find((bucket) => bucket.id === "queue_health")?.items.length).toBeGreaterThan(0);
    expect(workflow.buckets.find((bucket) => bucket.id === "data_quality")?.items.length).toBeGreaterThan(0);
    expect(workflow.buckets.find((bucket) => bucket.id === "maintainer_capacity")?.items.length).toBeGreaterThan(1);
    expect(workflow.nextSteps.length).toBeGreaterThan(0);
  });

  it("covers remaining workflow and view branch arms for coverage", () => {
    const warnDiscovery = buildRegistrationWorkspaceView(
      readyFixture({
        issueDiscoveryReadiness: {
          ready: false,
          recommendation: "allowed",
          reasons: ["Staff issue triage first."],
        },
        directPrReadiness: { ready: false, reasons: ["Warming up."] },
        blockers: [],
      }),
      {
        ...configFixture(),
        current: { maintainerCut: 0.1 },
        recommended: { maintainerCut: 0.2, participationMode: "direct_pr" },
      },
    );
    expect(warnDiscovery.lanes.issueDiscovery.status).toBe("warn");
    expect(warnDiscovery.lanes.directPr.status).toBe("warn");
    expect(warnDiscovery.config?.currentLines[0]).toMatch(/maintainerCut/);

    const workflow = buildRegistrationOwnerWorkflow(
      readyFixture({
        policyReadiness: {
          summary: "ok",
          publicWarnings: [
            {
              title: "Label drift",
              detail: "Registry label unused.",
              action: "",
              severity: "warn",
            },
          ],
        },
        queueHealth: { level: "medium", burdenScore: 0.55, reviewablePullRequests: 12, summary: "Moderate burden." },
        contributorIntakeHealth: { level: "strained", summary: "Intake strained." },
        docsCompleteness: {
          status: "verified",
          requiredDocs: ["CONTRIBUTING.md"],
          note: "Docs verified.",
        },
        maintainerCutReadiness: { ready: false, reasons: [], warnings: [] },
        blockers: [],
        ready: true,
      }),
      null,
    );
    expect(workflow.buckets.find((bucket) => bucket.id === "policy")?.items[0]?.remediationKind).toBe("manual");
    expect(workflow.overallHeadline).toMatch(/Needs cleanup/i);
    expect(workflow.buckets.find((bucket) => bucket.id === "queue_health")?.state).toBe("needs_cleanup");

    const highQueueWorkflow = buildRegistrationOwnerWorkflow(
      readyFixture({
        queueHealth: { level: "high", burdenScore: 0.8, reviewablePullRequests: 20, summary: "High burden." },
      }),
      null,
    );
    expect(highQueueWorkflow.buckets.find((bucket) => bucket.id === "queue_health")?.state).toBe("not_ready");

    const criticalQueue = buildRegistrationWorkspaceView(
      readyFixture({ queueHealth: { level: "critical", burdenScore: 1, reviewablePullRequests: 99, summary: "Critical." } }),
      null,
    );
    expect(criticalQueue.operations.find((section) => section.id === "queue-health")?.status).toBe("blocked");

    const edgeCases = buildRegistrationWorkspaceView(
      readyFixture({
        queueHealth: { level: "unknown", burdenScore: 0, reviewablePullRequests: 0, summary: "Unknown queue signal." },
        policyReadiness: {
          summary: "ok",
          publicWarnings: [
            { title: "Safe title", detail: "", action: "Fix manifest.", severity: "warn" },
            { title: "Actionable", detail: "Detail text.", action: "Do the thing.", severity: "warn" },
          ],
        },
        blockers: ["Burden forecast drift requires refresh.", "coverage gate below threshold."],
      }),
      {
        ...configFixture(),
        recommended: { participationMode: "direct_pr", maintainerCut: 0.2, nested: { flag: true } },
      },
    );
    expect(edgeCases.operations.find((section) => section.id === "queue-health")?.status).toBe("info");
    expect(edgeCases.policyWarnings).toHaveLength(1);
    expect(collectRegistrationWorkspacePublicText(edgeCases).join(" ")).toMatch(/Do the thing/i);
    expect(edgeCases.config?.recommendedLines.some((line) => line.includes("nested"))).toBe(true);

    const onlyAccepted = buildRegistrationOwnerWorkflow(
      readyFixture({
        docsCompleteness: { status: "verified", requiredDocs: [], note: "ok" },
        queueHealth: { level: "low", burdenScore: 0.1, reviewablePullRequests: 1, summary: "low" },
        contributorIntakeHealth: { level: "healthy", summary: "ok" },
        maintainerCutReadiness: { ready: true, reasons: [], warnings: [] },
        labelPolicy: { autoLabelEnabled: true, label: "gittensor", trustedPipelineReady: true, missingOrUnusedRegistryLabels: [] },
      }),
      configFixture(),
    );
    expect(onlyAccepted.overallState).toBe("accepted");
    expect(onlyAccepted.nextSteps).toEqual([]);

    const maintainerWarn = buildRegistrationWorkspaceView(
      readyFixture({
        ready: true,
        maintainerCutReadiness: { ready: false, reasons: ["Review cut."], warnings: [], summary: "Cut pending." },
      }),
      configFixture(),
    );
    expect(maintainerWarn.lanes.maintainerEconomics.status).toBe("warn");

    const installBlocker = buildRegistrationOwnerWorkflow(
      readyFixture({ blockers: ["GitHub App installation is incomplete for this repository."] }),
      null,
    );
    expect(
      installBlocker.buckets
        .find((bucket) => bucket.id === "maintainer_capacity")
        ?.items.some((item) => item.remediationKind === "manual"),
    ).toBe(true);
  });

  it("splitRepoFullName validates owner/repo slugs for the owner panel", () => {
    expect(splitRepoFullName("JSONbored/gittensory")).toEqual({ owner: "JSONbored", repo: "gittensory" });
    expect(splitRepoFullName("bad")).toBeNull();
  });

  it("never emits forbidden language across randomized warning injections", () => {
    const injections = [
      "wallet",
      "hotkey",
      "raw trust score",
      "payout",
      "reward estimate",
      "farming",
      "private reviewability",
      "public score estimate",
    ];
    for (const injection of injections) {
      const view = buildRegistrationWorkspaceView(
        readyFixture({ warnings: [`Blocked phrase ${injection} must not render`] }),
        configFixture(),
      );
      expect(collectRegistrationWorkspacePublicText(view).join(" ")).not.toMatch(FORBIDDEN);
      expect(collectRegistrationOwnerWorkflowPublicText(view.workflow).join(" ")).not.toMatch(FORBIDDEN);
    }
  });
});
