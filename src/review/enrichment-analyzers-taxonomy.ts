import analyzerMetadata from "../../review-enrichment/analyzer-metadata.json";

/** MCP resource URI for the REES enrichment analyzer taxonomy (#2226). */
export const ENRICHMENT_ANALYZERS_URI = "gittensory://enrichment-analyzers" as const;

type AnalyzerMetadataFile = {
  defaultProfile: string;
  analyzers: Array<{
    name: string;
    category: string;
    cost: string;
    profiles: string[];
  }>;
};

export interface EnrichmentAnalyzerTaxonomyEntry {
  name: string;
  category: string;
  costClass: string;
  profiles: readonly string[];
}

export interface EnrichmentAnalyzersTaxonomyDocument {
  defaultProfile: string;
  analyzers: readonly EnrichmentAnalyzerTaxonomyEntry[];
}

/** Static taxonomy for REES enrichment analyzers — sourced from committed analyzer-metadata.json. */
export function buildEnrichmentAnalyzersTaxonomyDocument(): EnrichmentAnalyzersTaxonomyDocument {
  const metadata = analyzerMetadata as AnalyzerMetadataFile;
  return {
    defaultProfile: metadata.defaultProfile,
    analyzers: metadata.analyzers.map((analyzer) => ({
      name: analyzer.name,
      category: analyzer.category,
      costClass: analyzer.cost,
      profiles: [...analyzer.profiles],
    })),
  };
}
