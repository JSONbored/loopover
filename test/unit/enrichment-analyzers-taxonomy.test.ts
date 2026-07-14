import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEnrichmentAnalyzersTaxonomyDocument,
  ENRICHMENT_ANALYZERS_URI,
} from "../../src/review/enrichment-analyzers-taxonomy";
import { REES_ANALYZER_NAMES } from "../../src/review/enrichment-analyzer-names";

const metadataPath = join(process.cwd(), "review-enrichment/analyzer-metadata.json");

describe("enrichment analyzers taxonomy document", () => {
  it("projects analyzer-metadata.json into the MCP taxonomy shape", () => {
    const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      defaultProfile: string;
      analyzers: Array<{ name: string; category: string; cost: string; profiles: string[] }>;
    };
    const doc = buildEnrichmentAnalyzersTaxonomyDocument();
    expect(doc.defaultProfile).toBe(raw.defaultProfile);
    expect(doc.analyzers).toHaveLength(raw.analyzers.length);
    expect(doc.analyzers.map((a) => a.name)).toEqual(raw.analyzers.map((a) => a.name));
    for (const [index, analyzer] of raw.analyzers.entries()) {
      expect(doc.analyzers[index]).toEqual({
        name: analyzer.name,
        category: analyzer.category,
        costClass: analyzer.cost,
        profiles: [...analyzer.profiles],
      });
    }
  });

  it("includes the canonical REES analyzer categories", () => {
    const doc = buildEnrichmentAnalyzersTaxonomyDocument();
    const categories = new Set(doc.analyzers.map((analyzer) => analyzer.category));
    for (const category of ["supply-chain", "security", "performance", "ownership"]) {
      expect(categories).toContain(category);
    }
    for (const analyzer of doc.analyzers) {
      expect(analyzer.category.length).toBeGreaterThan(0);
      expect(analyzer.costClass.length).toBeGreaterThan(0);
      expect(analyzer.profiles.length).toBeGreaterThan(0);
    }
  });

  it("uses the stable MCP resource URI", () => {
    expect(ENRICHMENT_ANALYZERS_URI).toBe("gittensory://enrichment-analyzers");
  });
});

describe("REES_ANALYZER_NAMES stays in sync with analyzer-metadata.json", () => {
  const metadataNames = (
    JSON.parse(readFileSync(metadataPath, "utf8")) as { analyzers: Array<{ name: string }> }
  ).analyzers.map((a) => a.name);

  it("covers exactly the analyzers the metadata registry defines (no missing, no extra)", () => {
    // The canonical name list validates every operator `REES_ANALYZERS` env entry and per-repo
    // `.loopover.yml review.enrichment` toggle, so an analyzer present in the metadata registry but absent
    // here is silently un-toggleable/un-selectable. Compared as sets against the registry (the source of
    // truth) rather than a hardcoded count so a newly-added analyzer can't drift the two apart unnoticed.
    expect(new Set(REES_ANALYZER_NAMES)).toEqual(new Set(metadataNames));
  });

  it("includes duplicationDelta alongside duplication (regression for the one-entry gap)", () => {
    expect(REES_ANALYZER_NAMES).toContain("duplication");
    expect(REES_ANALYZER_NAMES).toContain("duplicationDelta");
  });

  it("has no duplicate entries", () => {
    expect(new Set(REES_ANALYZER_NAMES).size).toBe(REES_ANALYZER_NAMES.length);
  });
});
