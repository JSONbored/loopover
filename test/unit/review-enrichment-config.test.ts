import { describe, expect, it } from "vitest";
import { parseFocusManifest, reviewConfigToJson, resolveEnrichmentAnalyzerToggles, resolveRepoEnrichmentToggles } from "../../src/signals/focus-manifest";
import { resolveEnrichmentAnalyzerSelection, REES_ANALYZER_NAMES } from "../../src/review/enrichment-wire";

describe("resolveEnrichmentAnalyzerSelection (env + per-repo toggle composition)", () => {
  it("returns the env selection unchanged when there is no per-repo override", () => {
    expect(resolveEnrichmentAnalyzerSelection(undefined, undefined)).toBeUndefined();
    expect(resolveEnrichmentAnalyzerSelection(undefined, {})).toBeUndefined();
    expect(resolveEnrichmentAnalyzerSelection(["secret"], undefined)).toEqual(["secret"]);
  });

  it("keeps the implicit REES default when env is unset so profile filtering remains authoritative", () => {
    expect(resolveEnrichmentAnalyzerSelection(undefined, { secret: false })).toBeUndefined();
    expect(resolveEnrichmentAnalyzerSelection(undefined, { secret: true })).toBeUndefined();
  });

  it("filters an explicit env list by a disable toggle", () => {
    expect(resolveEnrichmentAnalyzerSelection(["dependency", "secret"], { secret: false })).toEqual(["dependency"]);
  });

  it("does not let a repo enable toggle widen an explicit operator env list", () => {
    expect(resolveEnrichmentAnalyzerSelection(["dependency"], { secret: true })).toEqual(["dependency"]);
  });

  it("can disable every analyzer in an explicit list, yielding an empty (not undefined) selection", () => {
    expect(resolveEnrichmentAnalyzerSelection(["dependency", "secret"], { dependency: false, secret: false })).toEqual([]);
  });

  it("preserves an explicit full-registry env list as explicit under a no-op re-enable toggle (does not collapse to undefined)", () => {
    const full = [...REES_ANALYZER_NAMES];
    // env explicitly selected every analyzer; a repo toggle re-enabling one already-present analyzer is a no-op —
    // the operator's EXPLICIT selection must be kept as an explicit list, not collapsed to the "run everything" default.
    expect(resolveEnrichmentAnalyzerSelection(full, { secret: true })).toEqual(full);
  });
});

describe("review.enrichment manifest parsing", () => {
  it("parses known analyzer keys into the review config and marks it present", () => {
    const manifest = parseFocusManifest({ review: { enrichment: { secret: false, redos: true } } });
    expect(manifest.review.enrichmentAnalyzers).toEqual({ secret: false, redos: true });
    expect(manifest.review.present).toBe(true);
    expect(manifest.warnings).toEqual([]);
  });

  it("warns and drops an unknown analyzer key", () => {
    const manifest = parseFocusManifest({ review: { enrichment: { secret: false, bogusAnalyzer: true } } });
    expect(manifest.review.enrichmentAnalyzers).toEqual({ secret: false });
    expect(manifest.warnings.join(" ")).toMatch(/unknown analyzer "bogusAnalyzer"/);
  });

  it("marks the review config absent (present false) when the review mapping sets no fields", () => {
    const manifest = parseFocusManifest({ review: {} });
    expect(manifest.review.present).toBe(false);
    expect(manifest.review.enrichmentAnalyzers).toEqual({});
  });

  it("warns and drops a known analyzer key whose value is not a boolean", () => {
    const manifest = parseFocusManifest({ review: { enrichment: { secret: 123 } } });
    expect(manifest.review.enrichmentAnalyzers).toEqual({});
    expect(manifest.warnings.length).toBeGreaterThan(0);
  });

  it("treats review.enrichment: null as absent (no toggles, no warning) — null means unset, not malformed", () => {
    const manifest = parseFocusManifest({ review: { enrichment: null } });
    expect(manifest.review.enrichmentAnalyzers).toEqual({});
    expect(manifest.warnings.join(" ")).not.toMatch(/enrichment/);
  });

  it("warns when review.enrichment is not a mapping and leaves the toggles empty", () => {
    const manifest = parseFocusManifest({ review: { enrichment: ["secret"] } });
    expect(manifest.review.enrichmentAnalyzers).toEqual({});
    expect(manifest.warnings.join(" ")).toMatch(/"review\.enrichment" must be a mapping/);
  });

  it("round-trips through reviewConfigToJson", () => {
    const manifest = parseFocusManifest({ review: { enrichment: { secret: false, redos: true } } });
    const json = reviewConfigToJson(manifest.review) as { enrichment?: Record<string, boolean> };
    expect(json.enrichment).toEqual({ secret: false, redos: true });
  });

  it("omits enrichment from the serialized JSON when no toggles are set", () => {
    const manifest = parseFocusManifest({ review: { footer: { text: "hi" } } });
    const json = reviewConfigToJson(manifest.review) as Record<string, unknown>;
    expect(json.enrichment).toBeUndefined();
  });
});

describe("resolveEnrichmentAnalyzerToggles", () => {
  it("returns the manifest toggles, or an empty map for a null (load-failure) manifest", () => {
    const manifest = parseFocusManifest({ review: { enrichment: { secret: false } } });
    expect(resolveEnrichmentAnalyzerToggles(manifest)).toEqual({ secret: false });
    expect(resolveEnrichmentAnalyzerToggles(null)).toEqual({});
  });
});

describe("resolveRepoEnrichmentToggles (fail-safe loader wrapper)", () => {
  it("returns the manifest toggles when the load succeeds", async () => {
    const manifest = parseFocusManifest({ review: { enrichment: { secret: false } } });
    expect(await resolveRepoEnrichmentToggles(() => Promise.resolve(manifest))).toEqual({ secret: false });
  });

  it("swallows a manifest load error and degrades to no toggles", async () => {
    expect(await resolveRepoEnrichmentToggles(() => Promise.reject(new Error("boom")))).toEqual({});
  });
});
