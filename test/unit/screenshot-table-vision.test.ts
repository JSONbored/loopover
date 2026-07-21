import { describe, expect, it } from "vitest";
import {
  buildScreenshotTableVisionFindings,
  buildScreenshotTableVisionUserPrompt,
  evaluateScreenshotTableVisionGate,
  parseScreenshotTableVisionResponse,
  parseScreenshotTableVisionSummary,
  SCREENSHOT_TABLE_VISION_FINDING_CODE,
} from "../../src/review/visual/screenshot-table-vision";
import type { AiReviewProviderKey } from "../../src/services/ai-review";
import { evaluateGateCheck } from "../../src/rules/advisory";
import type { Advisory } from "../../src/types";

const providerKey: AiReviewProviderKey = { provider: "anthropic", key: "sk-ant" };

describe("evaluateScreenshotTableVisionGate", () => {
  it("skips for a low-reputation submitter, even with pairs and BYOK configured (checked FIRST)", () => {
    expect(
      evaluateScreenshotTableVisionGate({ imagePairCount: 2, reputationSignal: "low", providerKey }),
    ).toEqual({ run: false, reason: "low_reputation" });
  });

  it("skips when BYOK is not configured and self-host vision isn't available, even with pairs and good reputation", () => {
    expect(
      evaluateScreenshotTableVisionGate({ imagePairCount: 2, reputationSignal: "neutral", providerKey: null }),
    ).toEqual({ run: false, reason: "byok_not_configured" });
    expect(
      evaluateScreenshotTableVisionGate({ imagePairCount: 2, reputationSignal: "trusted", providerKey: null, selfHostVisionAvailable: false }),
    ).toEqual({ run: false, reason: "byok_not_configured" });
  });

  it("skips when there are no image pairs, even with good reputation and BYOK configured", () => {
    expect(
      evaluateScreenshotTableVisionGate({ imagePairCount: 0, reputationSignal: "neutral", providerKey }),
    ).toEqual({ run: false, reason: "no_image_pairs" });
  });

  it("runs, capping pairCount at the MAX bound, for a neutral- or trusted-reputation submitter with BYOK configured", () => {
    expect(evaluateScreenshotTableVisionGate({ imagePairCount: 1, reputationSignal: "neutral", providerKey })).toEqual({
      run: true,
      pairCount: 1,
    });
    expect(evaluateScreenshotTableVisionGate({ imagePairCount: 5, reputationSignal: "trusted", providerKey })).toEqual({
      run: true,
      pairCount: 2,
    });
  });

  it("runs via a self-host local vision provider even with NO BYOK key configured", () => {
    expect(
      evaluateScreenshotTableVisionGate({ imagePairCount: 1, reputationSignal: "neutral", providerKey: null, selfHostVisionAvailable: true }),
    ).toEqual({ run: true, pairCount: 1 });
  });
});

describe("buildScreenshotTableVisionUserPrompt", () => {
  it("includes the PR title and pair count when a title is given", () => {
    const prompt = buildScreenshotTableVisionUserPrompt("Redesign the nav bar", 2);
    expect(prompt).toContain("Pull request title: Redesign the nav bar");
    expect(prompt).toContain("2 before/after image pair(s)");
    expect(prompt).toContain("before, after order");
  });

  it("omits the title line entirely for a blank/whitespace/undefined title", () => {
    expect(buildScreenshotTableVisionUserPrompt(undefined, 1)).not.toContain("Pull request title");
    expect(buildScreenshotTableVisionUserPrompt(null, 1)).not.toContain("Pull request title");
    expect(buildScreenshotTableVisionUserPrompt("   ", 1)).not.toContain("Pull request title");
  });
});

describe("parseScreenshotTableVisionResponse", () => {
  it("parses a valid findings array into public-safe entries", () => {
    const text = JSON.stringify({ findings: [{ pairIndex: 1, body: "Both images are the same screenshot." }] });
    expect(parseScreenshotTableVisionResponse(text, 2)).toEqual([{ pairIndex: 1, body: "Both images are the same screenshot." }]);
  });

  it("drops an entry with a pairIndex below 1", () => {
    const text = JSON.stringify({ findings: [{ pairIndex: 0, body: "Something is off." }] });
    expect(parseScreenshotTableVisionResponse(text, 2)).toEqual([]);
  });

  it("drops an entry whose pairIndex exceeds the number of pairs actually sent", () => {
    const text = JSON.stringify({ findings: [{ pairIndex: 3, body: "Something is off." }] });
    expect(parseScreenshotTableVisionResponse(text, 2)).toEqual([]);
  });

  it("drops a non-integer pairIndex", () => {
    const text = JSON.stringify({ findings: [{ pairIndex: 1.5, body: "Something is off." }] });
    expect(parseScreenshotTableVisionResponse(text, 2)).toEqual([]);
  });

  it("drops an entry with a blank/empty body (fails toPublicSafe's emptiness guard)", () => {
    const text = JSON.stringify({ findings: [{ pairIndex: 1, body: "" }] });
    expect(parseScreenshotTableVisionResponse(text, 2)).toEqual([]);
  });

  it("drops a non-object entry and a findings value that isn't an array", () => {
    expect(parseScreenshotTableVisionResponse(JSON.stringify({ findings: ["just a string"] }), 2)).toEqual([]);
    expect(parseScreenshotTableVisionResponse(JSON.stringify({ findings: "not an array" }), 2)).toEqual([]);
  });

  it("drops an entry whose pairIndex is not a number and whose body is missing", () => {
    expect(parseScreenshotTableVisionResponse(JSON.stringify({ findings: [{ pairIndex: "1", body: "x" }] }), 2)).toEqual([]);
    expect(parseScreenshotTableVisionResponse(JSON.stringify({ findings: [{ pairIndex: 1 }] }), 2)).toEqual([]);
  });

  it("returns [] for text with no JSON object at all", () => {
    expect(parseScreenshotTableVisionResponse("not json, just prose", 2)).toEqual([]);
  });

  it("returns [] for a balanced-brace object that is still invalid JSON (e.g. a trailing comma)", () => {
    expect(parseScreenshotTableVisionResponse('{"findings": [1,]}', 2)).toEqual([]);
  });

  it("caps the result at MAX_SCREENSHOT_TABLE_VISION_FINDINGS even when the model returns more", () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({ pairIndex: 1, body: `Issue ${i}.` }));
    expect(parseScreenshotTableVisionResponse(JSON.stringify({ findings }), 2)).toHaveLength(2);
  });

  it("(#screenshot-vision-summary) an extra 'summary' field in the same response never affects findings-parsing", () => {
    const text = JSON.stringify({
      findings: [{ pairIndex: 1, body: "Both images are the same screenshot." }],
      summary: "The after screenshot moves the nav bar to the right, matching the PR's stated redesign.",
    });
    expect(parseScreenshotTableVisionResponse(text, 2)).toEqual([{ pairIndex: 1, body: "Both images are the same screenshot." }]);
  });
});

describe("parseScreenshotTableVisionSummary (#screenshot-vision-summary)", () => {
  it("parses a valid summary string into public-safe text", () => {
    const text = JSON.stringify({
      findings: [],
      summary: "The after screenshot shows the nav bar moved to the right, matching the PR's stated redesign.",
    });
    expect(parseScreenshotTableVisionSummary(text)).toBe(
      "The after screenshot shows the nav bar moved to the right, matching the PR's stated redesign.",
    );
  });

  it("is independent of the findings array -- a response with real findings still yields its summary", () => {
    const text = JSON.stringify({
      findings: [{ pairIndex: 1, body: "Both images are the same screenshot." }],
      summary: "The two screenshots look identical, which does not support the stated change.",
    });
    expect(parseScreenshotTableVisionSummary(text)).toBe(
      "The two screenshots look identical, which does not support the stated change.",
    );
  });

  it("returns undefined for a missing summary field", () => {
    expect(parseScreenshotTableVisionSummary(JSON.stringify({ findings: [] }))).toBeUndefined();
  });

  it("returns undefined for a non-string summary field", () => {
    expect(parseScreenshotTableVisionSummary(JSON.stringify({ findings: [], summary: 42 }))).toBeUndefined();
  });

  it("returns undefined for a blank/whitespace-only summary (fails toPublicSafe's emptiness guard)", () => {
    expect(parseScreenshotTableVisionSummary(JSON.stringify({ findings: [], summary: "   " }))).toBeUndefined();
  });

  it("returns undefined for text with no JSON object at all", () => {
    expect(parseScreenshotTableVisionSummary("not json, just prose")).toBeUndefined();
  });

  it("returns undefined for a balanced-brace object that is still invalid JSON (e.g. a trailing comma)", () => {
    expect(parseScreenshotTableVisionSummary('{"summary": "x",}')).toBeUndefined();
  });

  it("truncates a summary longer than MAX_SCREENSHOT_TABLE_VISION_SUMMARY_CHARS", () => {
    const longSummary = "A".repeat(1000);
    const result = parseScreenshotTableVisionSummary(JSON.stringify({ findings: [], summary: longSummary }));
    expect(result).toBeDefined();
    expect(result?.length).toBe(600);
  });

  it("trims a summary within the bound instead of always slicing to the max", () => {
    expect(parseScreenshotTableVisionSummary(JSON.stringify({ findings: [], summary: "  A short summary.  " }))).toBe(
      "A short summary.",
    );
  });
});

describe("buildScreenshotTableVisionFindings", () => {
  it("maps each vision finding into an advisory-only, non-blocking AdvisoryFinding", () => {
    const findings = buildScreenshotTableVisionFindings([{ pairIndex: 1, body: "Both images are the same screenshot." }]);
    expect(findings).toEqual([
      {
        code: SCREENSHOT_TABLE_VISION_FINDING_CODE,
        severity: "warning",
        title: "Possible screenshot-table issue: pair 1",
        detail: "Both images are the same screenshot.",
        action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
      },
    ]);
  });

  it("returns [] for an empty findings list", () => {
    expect(buildScreenshotTableVisionFindings([])).toEqual([]);
  });
});

describe("REGRESSION (#4366): a screenshot-table-vision finding can NEVER become a gate blocker", () => {
  it("stays in gate.warnings (never gate.blockers) and the gate conclusion stays 'success' regardless of policy", () => {
    const advisory: Advisory = {
      id: "advisory-screenshot-vision",
      targetType: "pull_request",
      targetKey: "owner/repo#9",
      repoFullName: "owner/repo",
      pullNumber: 9,
      headSha: "sha9",
      conclusion: "neutral",
      severity: "warning",
      title: "LoopOver advisory available",
      summary: "1 advisory finding generated.",
      findings: buildScreenshotTableVisionFindings([{ pairIndex: 1, body: "Both images are the same screenshot." }]),
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
