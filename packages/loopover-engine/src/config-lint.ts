import { parse as parseYaml } from "yaml";
import { MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent } from "./focus-manifest.js";

const TOP_LEVEL_FIELDS = [
  "source",
  "wantedPaths",
  "preferredLabels",
  "linkedIssuePolicy",
  "testExpectations",
  "issueDiscoveryPolicy",
  "maintainerNotes",
  "publicNotes",
  "gate",
  "settings",
  "review",
  "features",
  "experimental",
  "contentLane",
  "repoDocGeneration",
  "reviewRecap",
  "maintainerRecap",
  "ops",
  "publicStats",
  "draftFlow",
  "upstreamDriftIssues",
  "sweepWatchdog",
  "prReconciliation",
  "activeReviewReconciliation",
  "loopEscalation",
  "federatedIntelligence",
] as const;

const TOP_LEVEL_FIELD_SET = new Set<string>(TOP_LEVEL_FIELDS);
const NO_RECOGNIZED_FOCUS_FIELDS_WARNING =
  "Manifest contained no recognized focus fields; falling back to deterministic signals.";

export type SelfHostConfigLintResult = {
  ok: boolean;
  warnings: string[];
  recognizedFields: string[];
  summary: string;
};

export function lintManifestText(text: string | null | undefined): SelfHostConfigLintResult {
  const manifest = parseFocusManifestContent(text, "repo_file");
  const recognizedFields = recognizedFieldsFor(text);
  const warnings = [
    ...manifest.warnings
      .map(redactManifestWarning)
      .filter((warning) => recognizedFields.length === 0 || warning !== NO_RECOGNIZED_FOCUS_FIELDS_WARNING),
    ...unknownTopLevelWarnings(text),
  ];
  if (warnings.length === 0 && recognizedFields.length === 0) {
    warnings.push("Manifest did not define any recognized focus fields.");
  }
  const ok = warnings.length === 0 && recognizedFields.length > 0;
  return {
    ok,
    warnings,
    recognizedFields,
    summary: ok
      ? `Manifest parsed ${recognizedFields.length} recognized field${recognizedFields.length === 1 ? "" : "s"}.`
      : `Manifest has ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
  };
}

function recognizedFieldsFor(text: string | null | undefined): string[] {
  const parsed = parseManifestTopLevelObject(text);
  if (parsed === null) return [];
  return TOP_LEVEL_FIELDS.filter(
    (field) => field !== "source" && Object.prototype.hasOwnProperty.call(parsed, field),
  );
}

// Fields retired from TOP_LEVEL_FIELDS that still warrant a migration-specific warning (rather than the
// generic "unknown field" message) pointing operators at their replacement mechanism.
const RETIRED_FIELD_MIGRATION_WARNINGS: Record<string, string> = {
  blockedPaths: "blockedPaths is retired; use settings.hardGuardrailGlobs for path holds.",
};

export function unknownTopLevelWarnings(text: string | null | undefined): string[] {
  const parsed = parseManifestTopLevelObject(text);
  if (parsed === null) return [];
  const keys = Object.keys(parsed).filter((key) => !TOP_LEVEL_FIELD_SET.has(key));
  // `hasOwnProperty.call`, NOT `key in`: a manifest field named like an Object.prototype member
  // (`constructor`, `toString`, `hasOwnProperty`, ...) would otherwise test true for the inherited
  // property and resolve to the prototype's function instead of a real retired-field warning string,
  // corrupting the string[] result and suppressing the genuine unknown-field warning.
  const isRetired = (key: string): boolean => Object.prototype.hasOwnProperty.call(RETIRED_FIELD_MIGRATION_WARNINGS, key);
  const retiredWarnings = keys.filter(isRetired).map((key) => RETIRED_FIELD_MIGRATION_WARNINGS[key]!);
  const unknown = keys.filter((key) => !isRetired(key)).map(formatFieldName);
  return [
    ...retiredWarnings,
    ...(unknown.length > 0 ? [`Manifest contains unknown top-level field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`] : []),
  ];
}

// Single top-level-object parser shared by both `recognizedFieldsFor` and `unknownTopLevelWarnings` so the two
// can never disagree on whether a given manifest text parses. When the text looks like JSON (`{`/`[`) but
// `JSON.parse` throws, it retries with `parseYaml`: YAML flow mappings can start with "{" or "[" (e.g. unquoted
// keys) while still being valid manifest syntax, so a strict-JSON failure alone must not be treated as unparseable.
function parseManifestTopLevelObject(text: string | null | undefined): Record<string, unknown> | null {
  const raw = text ?? "";
  const trimmed = raw.trim();
  if (!trimmed || isOversize(raw)) return null;
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksLikeJson) {
    try {
      return topLevelObjectOrNull(JSON.parse(trimmed));
    } catch {
      // Fall through to YAML: a `{`/`[` prefix can be a valid YAML flow mapping that is invalid strict JSON.
    }
  }
  try {
    return topLevelObjectOrNull(parseYaml(trimmed));
  } catch {
    return null;
  }
}

function topLevelObjectOrNull(parsed: unknown): Record<string, unknown> | null {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function isOversize(text: string): boolean {
  return text.length > MAX_FOCUS_MANIFEST_BYTES || new TextEncoder().encode(text).byteLength > MAX_FOCUS_MANIFEST_BYTES;
}

function formatFieldName(name: string): string {
  const trimmed = name.replace(/[^\w.-]/g, "_").slice(0, 80);
  return trimmed || "<blank>";
}

function redactManifestWarning(warning: string): string {
  return warning
    .replace(/; ignoring "[^"]*"\./g, "; ignoring the supplied value.")
    .replace(/; ignoring "[^"]*"/g, "; ignoring the supplied value")
    .replace(/falling back to "[^"]*"/g, "falling back to the default");
}
