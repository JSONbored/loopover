import { describe, expect, it } from "vitest";
import {
  buildVisualBugAnalysisUserPrompt,
  buildVisualRegressionFindings,
  buildVisualVisionUserPrompt,
  evaluateVisualVisionGate,
  parseVisualVisionResponse,
  routeHasConfirmedVisualRegression,
  selectRoutesForVisualVision,
  VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT,
  VISUAL_REGRESSION_FINDING_CODE,
  VISUAL_UNRELATED_ISSUE_FINDING_CODE,
} from "../../src/review/visual/visual-findings";
import type { CaptureRoute } from "../../src/review/visual/capture";
import type { AiReviewProviderKey } from "../../src/services/ai-review";
import { evaluateGateCheck } from "../../src/rules/advisory";
import type { Advisory } from "../../src/types";

const changedRoute = (path: string): CaptureRoute => ({
  path,
  beforeUrl: `https://api.example.dev/loopover/shot?key=before-${path}`,
  afterUrl: `https://api.example.dev/loopover/shot?key=after-${path}`,
  diffUrl: `https://api.example.dev/loopover/shot?key=diff-${path}`,
});
const unchangedRoute = (path: string): CaptureRoute => ({
  path,
  beforeUrl: `https://api.example.dev/loopover/shot?key=before-${path}`,
  afterUrl: `https://api.example.dev/loopover/shot?key=after-${path}`,
});
const providerKey: AiReviewProviderKey = { provider: "anthropic", key: "sk-ant" };

describe("routeHasConfirmedVisualRegression", () => {
  it("is true when the route has a desktop diff URL", () => {
    expect(routeHasConfirmedVisualRegression(changedRoute("/pricing"))).toBe(true);
  });

  it("is true when ONLY the mobile diff URL is present", () => {
    expect(routeHasConfirmedVisualRegression({ path: "/", diffUrlMobile: "https://x/shot?key=d" })).toBe(true);
  });

  it("is false for an unchanged route (no diff URL on either viewport)", () => {
    expect(routeHasConfirmedVisualRegression(unchangedRoute("/about"))).toBe(false);
    expect(routeHasConfirmedVisualRegression({ path: "/" })).toBe(false);
  });
});

describe("selectRoutesForVisualVision", () => {
  it("filters out unchanged routes, keeping only pixel-diff-confirmed ones", () => {
    const routes = [changedRoute("/a"), unchangedRoute("/b"), changedRoute("/c")];
    expect(selectRoutesForVisualVision(routes).map((r) => r.path)).toEqual(["/a", "/c"]);
  });

  it("caps the result at MAX_VISION_ROUTES even when more routes are confirmed changed", () => {
    const routes = [changedRoute("/a"), changedRoute("/b"), changedRoute("/c")];
    expect(selectRoutesForVisualVision(routes).map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("returns [] when no route is confirmed changed", () => {
    expect(selectRoutesForVisualVision([unchangedRoute("/a")])).toEqual([]);
    expect(selectRoutesForVisualVision([])).toEqual([]);
  });
});

describe("evaluateVisualVisionGate", () => {
  it("skips for a low-reputation submitter, even with a confirmed regression and BYOK configured (checked FIRST)", () => {
    expect(
      evaluateVisualVisionGate({ routes: [changedRoute("/a")], reputationSignal: "low", providerKey }),
    ).toEqual({ run: false, reason: "low_reputation" });
  });

  it("skips when BYOK is not configured, even with a confirmed regression and good reputation", () => {
    expect(
      evaluateVisualVisionGate({ routes: [changedRoute("/a")], reputationSignal: "neutral", providerKey: null }),
    ).toEqual({ run: false, reason: "byok_not_configured" });
    expect(
      evaluateVisualVisionGate({ routes: [changedRoute("/a")], reputationSignal: "trusted", providerKey: null }),
    ).toEqual({ run: false, reason: "byok_not_configured" });
  });

  it("skips when no route crossed the pixel-diff threshold, even with good reputation and BYOK configured", () => {
    expect(
      evaluateVisualVisionGate({ routes: [unchangedRoute("/a")], reputationSignal: "neutral", providerKey }),
    ).toEqual({ run: false, reason: "no_confirmed_regression" });
  });

  it("runs, returning the bounded confirmed-regression routes, for a neutral- or trusted-reputation submitter with BYOK configured", () => {
    const routes = [changedRoute("/a"), unchangedRoute("/b")];
    expect(evaluateVisualVisionGate({ routes, reputationSignal: "neutral", providerKey })).toEqual({
      run: true,
      routes: [changedRoute("/a")],
    });
    expect(evaluateVisualVisionGate({ routes, reputationSignal: "trusted", providerKey })).toEqual({
      run: true,
      routes: [changedRoute("/a")],
    });
  });

  it("runs via a self-host local vision provider even with NO BYOK key configured (#4335)", () => {
    expect(
      evaluateVisualVisionGate({ routes: [changedRoute("/a")], reputationSignal: "neutral", providerKey: null, selfHostVisionAvailable: true }),
    ).toEqual({ run: true, routes: [changedRoute("/a")] });
  });

  it("still skips when self-host vision is explicitly unavailable and there is no BYOK key either", () => {
    expect(
      evaluateVisualVisionGate({ routes: [changedRoute("/a")], reputationSignal: "neutral", providerKey: null, selfHostVisionAvailable: false }),
    ).toEqual({ run: false, reason: "byok_not_configured" });
  });
});

describe("buildVisualVisionUserPrompt", () => {
  it("renders one bullet per route path", () => {
    const prompt = buildVisualVisionUserPrompt([{ path: "/pricing" }, { path: "/about" }]);
    expect(prompt).toContain("- /pricing");
    expect(prompt).toContain("- /about");
    expect(prompt).toContain("before, after order");
  });
});

describe("VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT (review.visual.bugAnalysis)", () => {
  it("is a distinct prompt from VISUAL_VISION_SYSTEM_PROMPT, asking for a category per finding", () => {
    expect(VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT).toContain('"category"');
    expect(VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT).toContain("regression");
    expect(VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT).toContain("unrelated");
    expect(VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT).toContain("stated title/description");
  });
});

describe("buildVisualBugAnalysisUserPrompt", () => {
  it("renders one bullet per route path plus the PR's stated title and description", () => {
    const prompt = buildVisualBugAnalysisUserPrompt([{ path: "/pricing" }], { title: "Fix pricing table overflow", body: "Truncates the discount column on narrow screens." });
    expect(prompt).toContain("- /pricing");
    expect(prompt).toContain("Title: Fix pricing table overflow");
    expect(prompt).toContain("Description: Truncates the discount column on narrow screens.");
    expect(prompt).toContain("before, after order");
  });

  it("still produces a valid prompt with no title/body at all — a best-effort context addition, not a requirement", () => {
    const prompt = buildVisualBugAnalysisUserPrompt([{ path: "/" }], {});
    expect(prompt).not.toContain("Pull request's stated change");
    expect(prompt).toContain("Route(s) under review:\n- /");
  });

  it("truncates an overlong description to 2000 chars rather than sending it unbounded", () => {
    const longBody = "x".repeat(3000);
    const prompt = buildVisualBugAnalysisUserPrompt([{ path: "/" }], { title: null, body: longBody });
    expect(prompt).toContain(`Description: ${"x".repeat(2000)}`);
    expect(prompt).not.toContain("x".repeat(2001));
  });

  it("omits the title line when only a body is set, and vice versa", () => {
    const bodyOnly = buildVisualBugAnalysisUserPrompt([{ path: "/" }], { body: "Just a description." });
    expect(bodyOnly).not.toContain("Title:");
    expect(bodyOnly).toContain("Description: Just a description.");
    const titleOnly = buildVisualBugAnalysisUserPrompt([{ path: "/" }], { title: "Just a title" });
    expect(titleOnly).toContain("Title: Just a title");
    expect(titleOnly).not.toContain("Description:");
  });
});

describe("parseVisualVisionResponse", () => {
  it("parses a valid findings array into public-safe entries", () => {
    const text = JSON.stringify({ findings: [{ path: "/pricing", body: "The third column lost its border." }] });
    expect(parseVisualVisionResponse(text)).toEqual([{ path: "/pricing", body: "The third column lost its border." }]);
  });

  it("drops an entry with a blank path", () => {
    const text = JSON.stringify({ findings: [{ path: "  ", body: "Something broke." }] });
    expect(parseVisualVisionResponse(text)).toEqual([]);
  });

  it("drops an entry with a blank/empty body (fails toPublicSafe's emptiness guard)", () => {
    const text = JSON.stringify({ findings: [{ path: "/pricing", body: "" }] });
    expect(parseVisualVisionResponse(text)).toEqual([]);
  });

  it("drops a non-object entry and a findings value that isn't an array", () => {
    expect(parseVisualVisionResponse(JSON.stringify({ findings: ["just a string"] }))).toEqual([]);
    expect(parseVisualVisionResponse(JSON.stringify({ findings: "not an array" }))).toEqual([]);
  });

  it("drops an entry whose path is not a string (coerces to the empty-string fallback, then fails the blank guard)", () => {
    const text = JSON.stringify({ findings: [{ path: 123, body: "Something broke." }] });
    expect(parseVisualVisionResponse(text)).toEqual([]);
  });

  it("drops an entry whose body is missing/not a string (coerces to the empty-string fallback, then fails toPublicSafe)", () => {
    const text = JSON.stringify({ findings: [{ path: "/pricing" }] });
    expect(parseVisualVisionResponse(text)).toEqual([]);
  });

  it("returns [] for text with no JSON object at all", () => {
    expect(parseVisualVisionResponse("not json, just prose")).toEqual([]);
  });

  it("returns [] for a balanced-brace object that is still invalid JSON (e.g. a trailing comma)", () => {
    // extractLastJsonObject only brace-matches — it happily extracts this SYNTACTICALLY invalid JSON (a
    // trailing comma), so JSON.parse itself must throw and be caught.
    expect(parseVisualVisionResponse('{"findings": [1,]}')).toEqual([]);
  });

  it("caps the result at MAX_VISUAL_FINDINGS even when the model returns more", () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({ path: `/r${i}`, body: `Issue ${i}.` }));
    expect(parseVisualVisionResponse(JSON.stringify({ findings }))).toHaveLength(3);
  });

  it("parses a valid 'unrelated' category (review.visual.bugAnalysis)", () => {
    const text = JSON.stringify({ findings: [{ path: "/pricing", body: "The footer logo is stretched, unrelated to this change.", category: "unrelated" }] });
    expect(parseVisualVisionResponse(text)).toEqual([
      { path: "/pricing", body: "The footer logo is stretched, unrelated to this change.", category: "unrelated" },
    ]);
  });

  it("parses an explicit 'regression' category the same as omitting it", () => {
    const text = JSON.stringify({ findings: [{ path: "/pricing", body: "Broke on this PR's change.", category: "regression" }] });
    expect(parseVisualVisionResponse(text)).toEqual([{ path: "/pricing", body: "Broke on this PR's change.", category: "regression" }]);
  });

  it("drops an unrecognized category value, keeping the finding with category left undefined (defaults to regression downstream)", () => {
    const text = JSON.stringify({ findings: [{ path: "/pricing", body: "Something's off.", category: "cosmetic" }] });
    expect(parseVisualVisionResponse(text)).toEqual([{ path: "/pricing", body: "Something's off." }]);
  });

  it("leaves category undefined when absent, byte-identical to the pre-bugAnalysis response shape", () => {
    const text = JSON.stringify({ findings: [{ path: "/pricing", body: "The third column lost its border." }] });
    const parsed = parseVisualVisionResponse(text);
    expect(parsed).toEqual([{ path: "/pricing", body: "The third column lost its border." }]);
    expect(parsed[0]).not.toHaveProperty("category");
  });
});

describe("buildVisualRegressionFindings", () => {
  it("maps each vision finding into an advisory-only, non-blocking AdvisoryFinding", () => {
    const findings = buildVisualRegressionFindings([{ path: "/pricing", body: "The third column lost its border." }]);
    expect(findings).toEqual([
      {
        code: VISUAL_REGRESSION_FINDING_CODE,
        severity: "warning",
        title: "Possible visual regression: /pricing",
        detail: "The third column lost its border.",
        action: "Advisory only — verify against the Visual preview screenshots before deciding.",
      },
    ]);
  });

  it("returns [] for an empty findings list", () => {
    expect(buildVisualRegressionFindings([])).toEqual([]);
  });

  it("maps a category:'regression' finding the SAME as an uncategorized one — byte-identical output", () => {
    const uncategorized = buildVisualRegressionFindings([{ path: "/pricing", body: "Broke." }]);
    const explicit = buildVisualRegressionFindings([{ path: "/pricing", body: "Broke.", category: "regression" }]);
    expect(explicit).toEqual(uncategorized);
  });

  it("maps a category:'unrelated' finding to its OWN code + a suggestion to open a new issue", () => {
    const findings = buildVisualRegressionFindings([{ path: "/footer", body: "The footer logo is stretched.", category: "unrelated" }]);
    expect(findings).toEqual([
      {
        code: VISUAL_UNRELATED_ISSUE_FINDING_CODE,
        severity: "warning",
        title: "Possible unrelated visual issue: /footer",
        detail: "The footer logo is stretched.",
        action: "Advisory only — this doesn't look related to this PR's stated change. Consider opening a new issue to track it separately.",
      },
    ]);
  });

  it("handles a mixed regression + unrelated findings list, each mapped to its own code", () => {
    const findings = buildVisualRegressionFindings([
      { path: "/pricing", body: "This PR broke the layout.", category: "regression" },
      { path: "/footer", body: "Pre-existing stretched logo.", category: "unrelated" },
    ]);
    expect(findings.map((f) => f.code)).toEqual([VISUAL_REGRESSION_FINDING_CODE, VISUAL_UNRELATED_ISSUE_FINDING_CODE]);
  });
});

describe("REGRESSION (#4111): a visual-regression finding can NEVER become a gate blocker", () => {
  it("stays in gate.warnings (never gate.blockers) and the gate conclusion stays 'success' regardless of policy", () => {
    const advisory: Advisory = {
      id: "advisory-visual",
      targetType: "pull_request",
      targetKey: "owner/repo#9",
      repoFullName: "owner/repo",
      pullNumber: 9,
      headSha: "sha9",
      conclusion: "neutral",
      severity: "warning",
      title: "LoopOver advisory available",
      summary: "1 advisory finding generated.",
      findings: buildVisualRegressionFindings([{ path: "/pricing", body: "The third column lost its border." }]),
      generatedAt: "2026-07-07T00:00:00.000Z",
    };
    // Even a maximally permissive/aggressive policy (every optional gate mode set to "block") must not promote
    // visual_regression_finding — it simply is not one of the codes isConfiguredGateBlocker recognizes.
    const result = evaluateGateCheck(advisory, {
      confirmedContributor: true,
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "block",
      aiReviewGateMode: "block",
      manifestPolicyGateMode: "block",
      selfAuthoredLinkedIssueGateMode: "block",
      linkedIssueSatisfactionGateMode: "block",
      lockfileIntegrityGateMode: "block",
      claGateMode: "block",
    });
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual(advisory.findings);
  });
});

describe("REGRESSION: a visual-UNRELATED-issue finding can NEVER become a gate blocker either", () => {
  it("stays in gate.warnings (never gate.blockers) and the gate conclusion stays 'success' regardless of policy", () => {
    const advisory: Advisory = {
      id: "advisory-visual-unrelated",
      targetType: "pull_request",
      targetKey: "owner/repo#10",
      repoFullName: "owner/repo",
      pullNumber: 10,
      headSha: "sha10",
      conclusion: "neutral",
      severity: "warning",
      title: "LoopOver advisory available",
      summary: "1 advisory finding generated.",
      findings: buildVisualRegressionFindings([{ path: "/footer", body: "Pre-existing stretched logo.", category: "unrelated" }]),
      generatedAt: "2026-07-07T00:00:00.000Z",
    };
    const result = evaluateGateCheck(advisory, {
      confirmedContributor: true,
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "block",
      aiReviewGateMode: "block",
      manifestPolicyGateMode: "block",
      selfAuthoredLinkedIssueGateMode: "block",
      linkedIssueSatisfactionGateMode: "block",
      lockfileIntegrityGateMode: "block",
      claGateMode: "block",
    });
    expect(result.conclusion).toBe("success");
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual(advisory.findings);
  });
});
