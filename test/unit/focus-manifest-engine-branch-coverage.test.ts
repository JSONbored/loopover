import { describe, expect, it } from "vitest";

import {
  gateConfigToJson,
  MAX_FOCUS_MANIFEST_BYTES,
  parseFocusManifest,
  parseFocusManifestContent,
  reviewConfigToJson,
} from "../../packages/gittensory-engine/src/focus-manifest";

describe("focus-manifest engine branch coverage (#2280)", () => {
  it("warns when settings.linkedIssueHardRules is not an object", () => {
    const parsed = parseFocusManifest({ settings: { linkedIssueHardRules: "not-an-object" } });
    expect(parsed.settings.linkedIssueHardRules).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes('settings.linkedIssueHardRules" must be an object'))).toBe(true);
  });

  it("warns on malformed review.enrichment and unknown analyzer keys", () => {
    const parsed = parseFocusManifest({
      review: {
        enrichment: "not-a-mapping",
      },
    });
    expect(parsed.review.enrichmentAnalyzers).toEqual({});
    expect(parsed.warnings.some((w) => w.includes('review.enrichment" must be a mapping'))).toBe(true);

    const withUnknown = parseFocusManifest({
      review: {
        enrichment: { dependency: true, notARealAnalyzer: false },
      },
    });
    expect(withUnknown.review.enrichmentAnalyzers).toEqual({ dependency: true });
    expect(withUnknown.warnings.some((w) => w.includes('unknown analyzer "notARealAnalyzer"'))).toBe(true);
  });

  it("rejects manifest content whose UTF-8 byte length exceeds MAX_FOCUS_MANIFEST_BYTES", () => {
    const oversized = `wantedPaths:\n  - ${"x".repeat(MAX_FOCUS_MANIFEST_BYTES)}`;
    const parsed = parseFocusManifestContent(oversized);
    expect(parsed.present).toBe(false);
    expect(parsed.warnings.some((w) => w.includes(`${MAX_FOCUS_MANIFEST_BYTES} bytes`))).toBe(true);
  });

  it("serializes gate pack, slop-only mode, and partial cla blocks through gateConfigToJson", () => {
    const gate = parseFocusManifest({
      gate: {
        pack: "oss-anti-slop",
        slop: { mode: "block" },
        cla: { checkRunName: "CLA" },
      },
    }).gate;
    expect(gateConfigToJson(gate)).toMatchObject({
      pack: "oss-anti-slop",
      slop: { mode: "block" },
      cla: { checkRunName: "CLA" },
    });
  });

  it("parses sparse linkedIssueHardRules overlays and settings ai review fields", () => {
    const parsed = parseFocusManifest({
      settings: {
        aiReviewProvider: "openai",
        aiReviewModel: "gpt-4.1",
        manualReviewLabel: "needs-human",
        linkedIssueHardRules: {
          ownerAssignedClose: "block",
          assignedIssueClose: "off",
          missingPointLabelClose: "block",
          maintainerOnlyLabelClose: "off",
          pointBearingLabels: ["gittensor:priority"],
          maintainerOnlyLabels: ["maintainer-only"],
          defaultLabelRepo: true,
          verifyBeforeClose: false,
          closeDelaySeconds: 45,
        },
      },
    });
    expect(parsed.settings.aiReviewProvider).toBe("openai");
    expect(parsed.settings.aiReviewModel).toBe("gpt-4.1");
    expect(parsed.settings.manualReviewLabel).toBe("needs-human");
    expect(parsed.settings.linkedIssueHardRules).toMatchObject({
      ownerAssignedClose: "block",
      pointBearingLabels: ["gittensor:priority"],
      closeDelaySeconds: 45,
    });
  });

  it("accepts valid review enrichment toggles and rejects unsafe visual url templates", () => {
    const enriched = parseFocusManifest({
      review: {
        enrichment: { dependency: true, secret: false },
        visual: {
          preview: { url_template: "http://127.0.0.1/pr-{number}" },
        },
      },
    });
    expect(enriched.review.enrichmentAnalyzers).toEqual({ dependency: true, secret: false });
    expect(enriched.review.visual.preview.urlTemplate).toBeNull();
    expect(enriched.warnings.some((w) => w.includes("url_template"))).toBe(true);
  });

  it("serializes review optional fields through reviewConfigToJson", () => {
    const manifest = parseFocusManifest({
      review: {
        fixHandoff: true,
        auto_merge_summary: false,
        enrichment: { dependency: true },
        linkedIssueSatisfaction: "advisory",
        visual: { routes: { max_routes: 3 } },
      },
    });
    expect(reviewConfigToJson(manifest.review)).toMatchObject({
      fixHandoff: true,
      auto_merge_summary: false,
      enrichment: { dependency: true },
      linkedIssueSatisfaction: "advisory",
      visual: { routes: { max_routes: 3 } },
    });
  });

  it("covers remaining serializer and parser branch edges", () => {
    const slopScoreOnly = parseFocusManifest({ gate: { slop: { minScore: 55 } } });
    expect(gateConfigToJson(slopScoreOnly.gate)).toEqual({ slop: { minScore: 55 } });

    const invalidEnrichmentFlag = parseFocusManifest({
      review: { enrichment: { dependency: "not-a-boolean" } },
    });
    expect(invalidEnrichmentFlag.review.enrichmentAnalyzers).toEqual({});
    expect(invalidEnrichmentFlag.warnings.some((w) => w.includes("review.enrichment.dependency"))).toBe(true);

    const emptyTemplate = parseFocusManifest({
      review: { visual: { preview: { url_template: "" } } },
    });
    expect(emptyTemplate.review.visual.preview.urlTemplate).toBeNull();

    const withInstructions = parseFocusManifest({
      review: { instructions: "Prefer small diffs." },
    });
    expect(reviewConfigToJson(withInstructions.review)).toEqual({ instructions: "Prefer small diffs." });
  });
});
