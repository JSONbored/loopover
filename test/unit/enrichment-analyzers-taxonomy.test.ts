import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEnrichmentAnalyzersTaxonomyDocument,
  ENRICHMENT_ANALYZERS_URI,
} from "../../src/review/enrichment-analyzers-taxonomy";

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
