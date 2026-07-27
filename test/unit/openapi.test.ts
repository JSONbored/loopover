import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../../src/openapi/spec";
import {
  evaluateEscalationShape,
  evaluateEscalationOutputSchema,
  buildResultsPayloadShape,
  buildResultsPayloadOutputSchema,
  buildProgressSnapshotShape,
  buildProgressSnapshotOutputSchema,
  intakeIdeaShape,
  intakeIdeaOutputSchema,
  planIdeaClaimsOutputSchema,
  eligibilityPlanOutputSchema,
  scoreBreakdownOutputSchema,
  listPendingActionsOutputSchema,
  proposeActionOutputSchema,
  proposeActionShape,
  decidePendingActionOutputSchema,
  maintainerNoiseOutputSchema,
  amsMinerCohortOutputSchema,
  gatePrecisionOutputSchema,
  maintainerMeasurementReportOutputSchema,
  activationPreviewOutputSchema,
  validateLinkedIssueShape,
  validateLinkedIssueOutputSchema,
  checkBeforeStartShape,
  checkBeforeStartOutputSchema,
} from "../../src/mcp/server";

describe("OpenAPI contract", () => {
  it("exports the modern private-beta backend contract only", () => {
    const spec = buildOpenApiSpec();
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/v1/mcp/compatibility"]).toBeDefined();
    expect(spec.paths["/v1/public/github/repos/{owner}/{repo}/stats"]).toBeDefined();
    expect(spec.paths["/v1/registry/snapshot"]).toBeDefined();
    expect(spec.paths["/v1/finding-taxonomy"]).toBeDefined();
    expect(spec.paths["/v1/enrichment-analyzers"]).toBeDefined();
    expect(spec.paths["/v1/registry/changes"]).toBeDefined();
    expect(spec.paths["/v1/readiness"]).toBeDefined();
    expect(spec.paths["/v1/sync/status"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/intelligence"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/issue-quality"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/outcome-patterns"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/gate-config/effective"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/maintainer-noise"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/ams-miner-cohort"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/gate-precision"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/outcome-calibration"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/activation-preview"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/validate-linked-issue"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/check-before-start"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/registration-readiness"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/gittensor-config-recommendation"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/pulls/{number}/maintainer-packet"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/pulls/{number}/reviewability"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/pulls/{number}/ai-review-findings"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/profile"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/decision-pack"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/open-pr-monitor"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/pr-outcomes"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/repos/{owner}/{repo}/decision"]).toBeDefined();
    expect(spec.paths["/v1/preflight/pr"]).toBeDefined();
    expect(spec.paths["/v1/preflight/review-risk"]).toBeDefined();
    expect(spec.paths["/v1/preflight/local-diff"]).toBeDefined();
    expect(spec.paths["/v1/local/branch-analysis"]).toBeDefined();
    expect(spec.paths["/v1/agent/runs"]).toBeDefined();
    expect(spec.paths["/v1/agent/runs/{id}"]).toBeDefined();
    expect(spec.paths["/v1/agent/plan-next-work"]).toBeDefined();
    expect(spec.paths["/v1/agent/preflight-branch"]).toBeDefined();
    expect(spec.paths["/v1/agent/prepare-pr-packet"]).toBeDefined();
    expect(spec.paths["/v1/agent/explain-blockers"]).toBeDefined();
    expect(spec.paths["/v1/scoring/model"]).toBeDefined();
    expect(spec.paths["/v1/scoring/preview"]).toBeDefined();
    expect(spec.paths["/v1/scoring/eligibility-plan"]).toBeDefined();
    expect(spec.paths["/v1/scoring/explain-breakdown"]).toBeDefined();
    expect(spec.paths["/v1/upstream/status"]).toBeDefined();
    expect(spec.paths["/v1/upstream/ruleset"]).toBeDefined();
    expect(spec.paths["/v1/upstream/drift"]).toBeDefined();
    expect(spec.paths["/v1/bounties/{id}/advisory"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/settings-preview"]).toBeDefined();
    expect(spec.paths["/v1/app/overview"]).toBeDefined();
    expect(spec.paths["/v1/app/miner-dashboard"]).toBeDefined();
    expect(spec.paths["/v1/app/maintainer-dashboard"]).toBeDefined();
    expect(spec.paths["/v1/app/operator-dashboard"]).toBeDefined();
    expect(spec.paths["/v1/app/commands"]).toBeDefined();
    expect(spec.paths["/v1/app/commands/preview"]).toBeDefined();
    expect(spec.paths["/v1/app/commands/usefulness"]).toBeDefined();
    expect(spec.paths["/v1/app/commands/feedback"]).toBeDefined();
    expect(spec.paths["/v1/app/digest"]).toBeDefined();
    expect(spec.paths["/v1/app/digest/subscriptions"]).toBeDefined();
    expect(spec.paths["/v1/app/analytics/daily-rollups"]).toBeDefined();
    expect(spec.paths["/v1/auth/github/start"]).toBeDefined();
    expect(spec.paths["/v1/auth/github/callback"]).toBeDefined();
    expect(spec.paths["/v1/auth/github/device/start"]).toBeDefined();
    expect(spec.paths["/v1/auth/session"]).toBeDefined();
    expect(spec.paths["/v1/internal/jobs/repair-data-fidelity"]).toBeDefined();
    expect(spec.paths["/v1/installations/{id}/repair"]).toBeDefined();
    expect(spec.paths["/v1/installations/{id}/repair/refresh"]).toBeDefined();

    for (const removedPath of [
      "/v1/contributors/{login}/opportunities",
      "/v1/contributors/{login}/fit",
      "/v1/contributors/{login}/strategy",
      "/v1/contributors/{login}/reward-risk-strategy",
      "/v1/contributors/{login}/actions/recommendations",
      "/v1/contributors/{login}/outcome-history",
      "/v1/contributors/{login}/repos/{owner}/{repo}/recommendation",
      "/v1/contributors/{login}/repos/{owner}/{repo}/reward-risk",
      "/v1/repos/{owner}/{repo}/queue-health",
      "/v1/repos/{owner}/{repo}/collisions",
      "/v1/repos/{owner}/{repo}/config-quality",
      "/v1/repos/{owner}/{repo}/labels/audit",
      "/v1/repos/{owner}/{repo}/burden-forecast",
      "/v1/repos/{owner}/{repo}/registry-drift",
      "/v1/repos/{owner}/{repo}/maintainer-lane",
      "/v1/repos/{owner}/{repo}/pulls/{number}/review-intelligence",
      "/v1/repos/{owner}/{repo}/pulls/{number}/scoring-preview",
      "/v1/internal/jobs/generate-signal-snapshots/run",
      "/v1/auth/extension/session",
      "/v1/extension/pull-context",
    ]) {
      expect(spec.paths[removedPath]).toBeUndefined();
    }

    expect(spec.components?.schemas?.ContributorProfile).toBeDefined();
    expect(spec.components?.schemas?.McpCompatibility).toBeDefined();
    expect(spec.components?.schemas?.PublicRepoStats).toBeDefined();
    expect(spec.components?.schemas?.ContributorDecisionPack).toBeDefined();
    expect(spec.components?.schemas?.DecisionPackRefreshNeeded).toBeDefined();
    expect(spec.components?.schemas?.RepoDecisionResponse).toBeDefined();
    expect(spec.components?.schemas?.RepoIntelligence).toBeDefined();
    expect(spec.components?.schemas?.RepoOutcomePatterns).toBeDefined();
    expect(spec.components?.schemas?.RegistrationReadiness).toBeDefined();
    expect(spec.components?.schemas?.GittensorConfigRecommendation).toBeDefined();
    expect(spec.components?.schemas?.GatePrecisionResponse).toBeDefined();
    expect(spec.components?.schemas?.OutcomeCalibrationResponse).toBeDefined();
    expect(spec.components?.schemas?.ActivationPreviewResponse).toBeDefined();
    expect(spec.components?.schemas?.MaintainerNoiseReport).toBeDefined();
    expect(spec.components?.schemas?.AmsMinerCohortComparison).toBeDefined();
    expect(spec.components?.schemas?.PullRequestMaintainerPacket).toBeDefined();
    expect(spec.components?.schemas?.PullRequestReviewability).toBeDefined();
    expect(spec.components?.schemas?.PullRequestAiReviewFindings).toBeDefined();
    expect(JSON.stringify(spec.components?.schemas?.PullRequestAiReviewFindings)).toContain("categoryCounts");
    expect(spec.components?.schemas?.LocalBranchAnalysis).toBeDefined();
    expect(spec.components?.schemas?.RepoSettingsPreview).toBeDefined();
    expect(spec.components?.schemas?.InstallationRepair).toBeDefined();
    expect(spec.components?.schemas?.CommandPreviewResponse).toBeDefined();
    expect(spec.components?.schemas?.AgentRunBundle).toBeDefined();
    expect(spec.components?.schemas?.AgentAction).toBeDefined();
    expect(spec.components?.schemas?.UpstreamStatus).toBeDefined();
    expect(spec.components?.schemas?.UpstreamRulesetSnapshot).toBeDefined();
    expect(spec.components?.schemas?.UpstreamDriftReport).toBeDefined();
    expect(JSON.stringify(spec.components?.schemas?.ScorePreviewResult)).toContain("scenarioPreviews");
    expect(JSON.stringify(spec.components?.schemas?.AgentAction)).toContain("explanationCard");
    expect(JSON.stringify(spec.components?.schemas?.RepoIntelligence)).toContain("burdenForecastFreshness");
    expect(JSON.stringify(spec.components?.schemas?.CommandPreviewResponse)).toContain("missing_permission");
    expect(JSON.stringify(spec.components?.schemas?.ContributorOutcomeHistory)).toContain("reconciliation");
    expect(JSON.stringify(spec.components?.schemas?.ContributorDecisionPack)).toContain("recommendationOutcomeFeedback");
    expect(JSON.stringify(spec.components?.schemas?.LocalBranchAnalysis)).toContain("baseFreshness");
    expect(JSON.stringify(spec.components?.schemas?.LocalBranchAnalysis)).toContain("recommendedRerunCondition");
    expect(JSON.stringify(spec.components?.schemas?.Health)).toContain("minMcpVersion");
    expect(JSON.stringify(spec.components?.schemas?.Health)).toContain("latestRecommendedMcpVersion");
    expect(JSON.stringify(spec.components?.schemas?.McpCompatibility)).toContain("minimumSupportedVersion");
    expect(JSON.stringify(spec.components?.schemas?.McpCompatibility)).toContain("compatibilityWarnings");
    expect(spec.components?.securitySchemes?.LoopOverBearer).toBeDefined();
    expect(spec.components?.securitySchemes?.LoopOverSessionCookie).toBeDefined();
    expect(spec.paths["/health"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/mcp/compatibility"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/public/stats"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/public/github/repos/{owner}/{repo}/stats"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/auth/github/start"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/repos"]?.get?.security).toEqual([{ LoopOverBearer: [] }, { LoopOverSessionCookie: [] }]);
    expect(spec.paths["/v1/app/overview"]?.get?.security).toEqual([{ LoopOverBearer: [] }, { LoopOverSessionCookie: [] }]);
    expect(spec.paths["/v1/auth/session"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/auth/logout"]?.post?.security).toBeUndefined();
    expect(spec.paths["/v1/auth/github/token"]?.post?.security).toEqual([{ LoopOverBearer: [] }, { LoopOverSessionCookie: [] }]);
  });

  // #9307: the three agent/pending-actions approval-queue routes were undocumented while their agent/audit-feed
  // neighbor was. Assert each is registered with a response schema whose keys match the MCP tool output shape it
  // mirrors, so the OpenAPI contract can never drift from what loopover_{list,propose,decide}_pending_action validate.
  it("documents the agent/pending-actions routes with schemas matching their MCP tool shapes (#9307)", () => {
    const spec = buildOpenApiSpec();
    const schemaProps = (name: string) =>
      Object.keys((spec.components?.schemas?.[name] as { properties?: Record<string, unknown> })?.properties ?? {}).sort();

    const getOp = spec.paths["/v1/repos/{owner}/{repo}/agent/pending-actions"]?.get as {
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    expect(getOp?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/ListPendingActionsResponse",
    );
    expect(schemaProps("ListPendingActionsResponse")).toEqual(Object.keys(listPendingActionsOutputSchema).sort());

    const proposeOp = spec.paths["/v1/repos/{owner}/{repo}/agent/pending-actions"]?.post as {
      requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    expect(proposeOp?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/ProposeActionRequest");
    expect(schemaProps("ProposeActionRequest")).toEqual(
      Object.keys(proposeActionShape)
        .filter((k) => k !== "owner" && k !== "repo")
        .sort(),
    );
    expect(proposeOp?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/ProposeActionResponse",
    );
    expect(schemaProps("ProposeActionResponse")).toEqual(Object.keys(proposeActionOutputSchema).sort());

    const decideOp = spec.paths["/v1/repos/{owner}/{repo}/agent/pending-actions/{id}/{decision}"]?.post as {
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    expect(decideOp?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/DecidePendingActionResponse",
    );
    expect(schemaProps("DecidePendingActionResponse")).toEqual(Object.keys(decidePendingActionOutputSchema).sort());
  });

  // #5810: every operation needs a title in the generated spec and the rendered API browser. Iterating the built
  // document (rather than counting `summary:` lines in the source) also covers the paths registered from a loop,
  // and fails loudly when a future route is added without one.
  it("gives every operation a non-empty summary", () => {
    const spec = buildOpenApiSpec();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods as Record<string, { summary?: string }>)) {
        const label = `${method.toUpperCase()} ${path}`;
        expect(typeof operation.summary, `${label} is missing an operation-level summary`).toBe("string");
        expect(operation.summary?.trim(), `${label} has an empty operation-level summary`).not.toBe("");
      }
    }
  });

  // #9309: the five /v1/loop/* idea/task-graph composer routes are each backed by an MCP tool whose Zod
  // input/output shapes already live in src/mcp/server.ts. Assert every route is a documented POST path whose
  // request/response components stay field-for-field in parity with those tool shapes, so a future field added
  // to a tool but not the spec fails loudly here. request-apr-transfer is intentionally excluded from this batch.
  it("documents the /v1/loop/* idea/task-graph route family with tool-parity schemas (#9309)", () => {
    const spec = buildOpenApiSpec();
    const schemas = spec.components?.schemas ?? {};

    const propKeys = (name: string) =>
      Object.keys((schemas[name] as { properties?: Record<string, unknown> }).properties ?? {}).sort();

    const cases = [
      {
        path: "/v1/loop/evaluate-escalation",
        request: "EvaluateEscalationRequest",
        response: "EvaluateEscalationResponse",
        inputShape: evaluateEscalationShape,
        outputShape: evaluateEscalationOutputSchema,
      },
      {
        path: "/v1/loop/results-payload",
        request: "BuildResultsPayloadRequest",
        response: "BuildResultsPayloadResponse",
        inputShape: buildResultsPayloadShape,
        outputShape: buildResultsPayloadOutputSchema,
      },
      {
        path: "/v1/loop/progress-snapshot",
        request: "BuildProgressSnapshotRequest",
        response: "BuildProgressSnapshotResponse",
        inputShape: buildProgressSnapshotShape,
        outputShape: buildProgressSnapshotOutputSchema,
      },
      {
        path: "/v1/loop/intake-idea",
        request: "IntakeIdeaRequest",
        response: "IntakeIdeaResponse",
        inputShape: intakeIdeaShape,
        outputShape: intakeIdeaOutputSchema,
      },
      {
        // plan-idea-claims reuses intakeIdeaShape as its input; its output is the claim-plan disposition.
        path: "/v1/loop/plan-idea-claims",
        request: "PlanIdeaClaimsRequest",
        response: "PlanIdeaClaimsResponse",
        inputShape: intakeIdeaShape,
        outputShape: planIdeaClaimsOutputSchema,
      },
    ];

    for (const { path, request, response, inputShape, outputShape } of cases) {
      const op = spec.paths[path]?.post;
      expect(op, `${path} should be a documented POST path`).toBeDefined();
      expect(op?.requestBody, `${path} should document a request body`).toBeDefined();

      expect(schemas[request], `${request} component should be registered`).toBeDefined();
      expect(schemas[response], `${response} component should be registered`).toBeDefined();

      expect(propKeys(request)).toEqual(Object.keys(inputShape).sort());
      expect(propKeys(response)).toEqual(Object.keys(outputShape).sort());
    }

    // request-apr-transfer is explicitly out of scope for this batch and must stay undocumented here.
    expect(spec.paths["/v1/loop/request-apr-transfer"]).toBeUndefined();
  });

  // #9308: the eight /v1/lint/* + /v1/validate/focus-manifest advisory-check routes are each backed by an MCP
  // tool whose Zod input/output shapes live in src/mcp/server.ts. Assert every route is a documented POST path
  // whose request/response components expose exactly the tool's top-level keys (the MCP table in #9308), so a
  // future field added to a tool but not the spec (or a mis-registered component) fails loudly here.
  it("documents the /v1/lint/* + /v1/validate/focus-manifest advisory-check family with tool-parity schemas (#9308)", () => {
    const spec = buildOpenApiSpec();
    const schemas = spec.components?.schemas ?? {};

    const propKeys = (name: string) =>
      Object.keys((schemas[name] as { properties?: Record<string, unknown> }).properties ?? {}).sort();

    const cases = [
      {
        path: "/v1/lint/pr-text",
        request: "LintPrTextRequest",
        response: "LintPrTextResponse",
        inputKeys: ["commitMessages", "prBody", "linkedIssue"],
        outputKeys: ["verdict", "score", "components", "fixes", "summary", "generatedAt"],
      },
      {
        path: "/v1/lint/slop-risk",
        request: "CheckSlopRiskRequest",
        response: "CheckSlopRiskResponse",
        inputKeys: ["changedFiles", "description", "tests", "testFiles", "commitMessages", "hasLinkedIssue", "issueDiscoveryLane"],
        outputKeys: ["slopRisk", "band", "findings", "rubric"],
      },
      {
        path: "/v1/lint/improvement-potential",
        request: "CheckImprovementPotentialRequest",
        response: "CheckImprovementPotentialResponse",
        inputKeys: ["changedFiles", "tests", "testFiles", "patchCoverageDeltaPercent", "complexityDeltas", "duplicationDeltas"],
        outputKeys: ["improvementScore", "band", "findings"],
      },
      {
        path: "/v1/lint/open-pr-pressure",
        request: "SimulateOpenPrPressureRequest",
        response: "SimulateOpenPrPressureResponse",
        inputKeys: ["repoFullName", "generatedAt", "queueHealth", "roleContext", "contributorOpenPrCount"],
        outputKeys: ["repoFullName", "generatedAt", "lane", "queuePressure", "recommendedOption", "scenarios", "summary"],
      },
      {
        path: "/v1/lint/boundary-tests",
        request: "SuggestBoundaryTestsRequest",
        response: "SuggestBoundaryTestsResponse",
        inputKeys: ["changedFiles", "boundaryTouches", "tests", "testFiles"],
        outputKeys: ["finding", "spec"],
      },
      {
        path: "/v1/lint/test-evidence",
        request: "CheckTestEvidenceRequest",
        response: "CheckTestEvidenceResponse",
        inputKeys: ["changedPaths", "testFiles", "tests"],
        outputKeys: ["classification", "changedFileCount", "codeFileCount", "testFileCount", "guidance"],
      },
      {
        // issue-slop's MCP output is an alias of checkSlopRiskOutputSchema, so its keys match slop-risk's response.
        path: "/v1/lint/issue-slop",
        request: "CheckIssueSlopRequest",
        response: "CheckIssueSlopResponse",
        inputKeys: ["title", "body"],
        outputKeys: ["slopRisk", "band", "findings", "rubric"],
      },
      {
        path: "/v1/validate/focus-manifest",
        request: "ValidateFocusManifestRequest",
        response: "ValidateFocusManifestResponse",
        inputKeys: ["content", "source"],
        outputKeys: ["present", "warnings", "normalized", "status"],
      },
    ];

    for (const { path, request, response, inputKeys, outputKeys } of cases) {
      const op = spec.paths[path]?.post;
      expect(op, `${path} should be a documented POST path`).toBeDefined();
      expect(op?.requestBody, `${path} should document a request body`).toBeDefined();

      expect(schemas[request], `${request} component should be registered`).toBeDefined();
      expect(schemas[response], `${response} component should be registered`).toBeDefined();

      expect(propKeys(request)).toEqual([...inputKeys].sort());
      expect(propKeys(response)).toEqual([...outputKeys].sort());
    }
  });

  // #9301: the two /v1/scoring/* composer routes backed by loopover_get_eligibility_plan and
  // loopover_explain_score_breakdown. Assert each is a documented POST path whose 200 response
  // component stays field-for-field in parity with the MCP tool outputSchema.
  it("documents the /v1/scoring/eligibility-plan and /v1/scoring/explain-breakdown routes with tool-parity schemas (#9301)", () => {
    const spec = buildOpenApiSpec();
    const schemas = spec.components?.schemas ?? {};

    const propKeys = (name: string) =>
      Object.keys((schemas[name] as { properties?: Record<string, unknown> }).properties ?? {}).sort();

    const cases = [
      {
        path: "/v1/scoring/eligibility-plan",
        response: "EligibilityPlanResponse",
        outputShape: eligibilityPlanOutputSchema,
      },
      {
        path: "/v1/scoring/explain-breakdown",
        response: "ScoreBreakdownResponse",
        outputShape: scoreBreakdownOutputSchema,
      },
    ];

    for (const { path, response, outputShape } of cases) {
      const op = spec.paths[path]?.post;
      expect(op, `${path} should be a documented POST path`).toBeDefined();
      expect(op?.responses?.["200"], `${path} should document a 200 response`).toBeDefined();

      expect(schemas[response], `${response} component should be registered`).toBeDefined();
      expect(propKeys(response)).toEqual(Object.keys(outputShape).sort());
    }
  });

  // #9302: five maintainer-report GET routes are each backed by an MCP tool whose Zod output shape already
  // lives in src/mcp/server.ts. Assert every route is a documented GET path whose response component keys
  // stay field-for-field in parity with those tool shapes.
  it("documents the repo maintainer-report route family with tool-parity schemas (#9302)", () => {
    const spec = buildOpenApiSpec();
    const schemas = spec.components?.schemas ?? {};

    const propKeys = (name: string) =>
      Object.keys((schemas[name] as { properties?: Record<string, unknown> }).properties ?? {}).sort();

    const cases = [
      {
        path: "/v1/repos/{owner}/{repo}/maintainer-noise",
        response: "MaintainerNoiseReport",
        outputShape: maintainerNoiseOutputSchema,
      },
      {
        path: "/v1/repos/{owner}/{repo}/ams-miner-cohort",
        response: "AmsMinerCohortComparison",
        outputShape: amsMinerCohortOutputSchema,
      },
      {
        path: "/v1/repos/{owner}/{repo}/gate-precision",
        response: "GatePrecisionResponse",
        outputShape: gatePrecisionOutputSchema,
      },
      {
        path: "/v1/repos/{owner}/{repo}/outcome-calibration",
        response: "OutcomeCalibrationResponse",
        outputShape: maintainerMeasurementReportOutputSchema,
      },
      {
        path: "/v1/repos/{owner}/{repo}/activation-preview",
        response: "ActivationPreviewResponse",
        outputShape: activationPreviewOutputSchema,
      },
    ];

    for (const { path, response, outputShape } of cases) {
      const op = spec.paths[path]?.get;
      expect(op, `${path} should be a documented GET path`).toBeDefined();

      expect(schemas[response], `${response} component should be registered`).toBeDefined();
      expect(propKeys(response)).toEqual(Object.keys(outputShape).sort());
    }
  });

  // #9304: validate-linked-issue + check-before-start were live API+MCP routes but missing from the
  // OpenAPI contract. Assert both POSTs are documented with request/response components whose keys
  // match the MCP tool shapes (owner/repo stay path params, not request-body fields).
  it("documents validate-linked-issue and check-before-start with tool-parity schemas (#9304)", () => {
    const spec = buildOpenApiSpec();
    const schemas = spec.components?.schemas ?? {};

    const propKeys = (name: string) =>
      Object.keys((schemas[name] as { properties?: Record<string, unknown> }).properties ?? {}).sort();

    const cases = [
      {
        path: "/v1/repos/{owner}/{repo}/validate-linked-issue",
        request: "ValidateLinkedIssueRequest",
        response: "ValidateLinkedIssueResponse",
        inputShape: validateLinkedIssueShape,
        outputShape: validateLinkedIssueOutputSchema,
      },
      {
        path: "/v1/repos/{owner}/{repo}/check-before-start",
        request: "CheckBeforeStartRequest",
        response: "CheckBeforeStartResponse",
        inputShape: checkBeforeStartShape,
        outputShape: checkBeforeStartOutputSchema,
      },
    ];

    for (const { path, request, response, inputShape, outputShape } of cases) {
      const op = spec.paths[path]?.post;
      expect(op, `${path} should be a documented POST path`).toBeDefined();
      expect(op?.requestBody, `${path} should document a request body`).toBeDefined();
      expect(op?.responses?.["200"], `${path} should document a 200 response`).toBeDefined();

      expect(schemas[request], `${request} component should be registered`).toBeDefined();
      expect(schemas[response], `${response} component should be registered`).toBeDefined();

      expect(propKeys(request)).toEqual(
        Object.keys(inputShape)
          .filter((k) => k !== "owner" && k !== "repo")
          .sort(),
      );
      expect(propKeys(response)).toEqual(Object.keys(outputShape).sort());
    }
  });

  it("declares an `in: path` parameter for every {templated} path segment (Cloudflare schema-validation warning 30046)", () => {
    const spec = buildOpenApiSpec();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      const templateParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      if (templateParams.length === 0) continue;
      for (const [method, operation] of Object.entries(methods as Record<string, { parameters?: Array<{ name: string; in: string }> }>)) {
        const declared = new Set((operation.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name));
        for (const param of templateParams) {
          expect(declared.has(param), `${method.toUpperCase()} ${path} is missing a declared path parameter for {${param}}`).toBe(true);
        }
      }
    }
  });
});
