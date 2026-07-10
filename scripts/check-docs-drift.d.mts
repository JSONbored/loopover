export function extractGittensoryReviewFlags(envDtsText: string): string[];

export function extractCatalogIds(sourceText: string, catalogConstName: string): string[];

export function extractGateModeFields(typesText: string): string[];

export function extractRepositorySettingsFields(typesText: string): string[];

export function extractFocusManifestFields(focusManifestText: string): string[];

export type GateModeManifestRow = { field: string; aliases: string[]; pages: string[] };

export const GATE_MODE_MANIFEST: GateModeManifestRow[];

export type AliasManifestRow = { field: string; aliases: string[] };

export const SETTINGS_ALIAS_MANIFEST: AliasManifestRow[];

export const FOCUS_MANIFEST_ALIAS_MANIFEST: AliasManifestRow[];

export function checkDocsDrift(options: {
  root: string;
  readFile?: (root: string, relativePath: string) => string;
}): {
  failures: string[];
  counts: {
    flags: number;
    commands: number;
    gateModes: number;
    settingsFields: number;
    focusManifestFields: number;
  };
};
