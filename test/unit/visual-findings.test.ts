import { describe, expect, it } from "vitest";
import {
  buildVisualRegressionFindings,
  buildVisualVisionUserPrompt,
  evaluateVisualVisionGate,
  parseVisualVisionResponse,
  routeHasConfirmedVisualRegression,
  selectRoutesForVisualVision,
  VISUAL_REGRESSION_FINDING_CODE,
} from "../../src/review/visual/visual-findings";
import type { CaptureRoute } from "../../src/review/visual/capture";
import type { AiReviewProviderKey } from "../../src/services/ai-review";
import { evaluateGateCheck } from "../../src/rules/advisory";
import type { Advisory } from "../../src/types";

const changedRoute = (path: string): CaptureRoute => ({
  path,
  beforeUrl: `https://api.example.dev/gittensory/shot?key=before-${path}`,
  afterUrl: `https://api.example.dev/gittensory/shot?key=after-${path}`,
  diffUrl: `https://api.example.dev/gittensory/shot?key=diff-${path}`,
});
const unchangedRoute = (path: string): CaptureRoute => ({
  path,
  beforeUrl: `https://api.example.dev/gittensory/shot?key=before-${path}`,
  afterUrl: `https://api.example.dev/gittensory/shot?key=after-${path}`,
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
      title: "Gittensory advisory available",
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
