export function extractGittensoryReviewFlags(envDtsText: string): string[];

export function extractCatalogIds(sourceText: string, catalogConstName: string): string[];

export function extractGateModeFields(typesText: string): string[];

export type GateModeManifestRow = { field: string; aliases: string[]; pages: string[] };

export const GATE_MODE_MANIFEST: GateModeManifestRow[];

export function checkDocsDrift(options: {
  root: string;
  readFile?: (root: string, relativePath: string) => string;
}): {
  failures: string[];
  counts: { flags: number; commands: number; gateModes: number };
};
