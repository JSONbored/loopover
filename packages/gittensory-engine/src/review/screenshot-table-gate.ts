import { matchesAny } from "../signals/change-guardrail.js";
import type { ScreenshotTableGateAction, ScreenshotTableGateConfig } from "../types/manifest-deps-types.js";

export type { ScreenshotTableGateAction, ScreenshotTableGateConfig } from "../types/manifest-deps-types.js";

// Config-driven before/after screenshot-table gate (#2006). Contributor visual/frontend PRs are unreviewable
// at a glance without before/after evidence — this is a DETERMINISTIC (no AI, zero hallucination risk) check
// that a PR's body contains a markdown table with image markup, scoped to the repo's configured labels/paths.
// Mirrors the shape of contributor-blacklist.ts / linked-issue-hard-rules-config.ts: a normalizer (DB JSON or
// `.gittensory.yml` → validated config) plus a pure evaluator the trigger calls with live PR facts. Off by
// default (`enabled: false`) — a self-hoster opts in per repo, never hard-coded for any one project.

const MAX_LABELS = 50;
const MAX_PATHS = 50;
const MAX_LABEL_CHARS = 100;
const MAX_PATH_CHARS = 300;

// Extensions treated as "an image file" for the committed-image-file check below. Deliberately excludes SVG:
// an SVG can embed script/foreign-object content, so it is never accepted as review evidence anywhere in this
// repo (see the PR template's own UI Evidence rule) — a committed .svg is caught by neither this check nor the
// body-table one, exactly like the template's existing screenshots-must-be-raster rule.
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

export const DEFAULT_SCREENSHOT_TABLE_GATE: ScreenshotTableGateConfig = {
  enabled: false,
  whenLabels: [],
  whenPaths: [],
  action: "close",
};

const VALID_ACTIONS: readonly ScreenshotTableGateAction[] = ["close", "request_changes", "comment"];

export function isScreenshotTableGateAction(value: unknown): value is ScreenshotTableGateAction {
  return typeof value === "string" && (VALID_ACTIONS as readonly string[]).includes(value);
}

function normalizeStringList(value: unknown, field: string, max: number, maxChars: number, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`settings.requireScreenshotTable.${field} must be an array; ignoring it.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (out.length >= max) {
      warnings.push(`settings.requireScreenshotTable.${field} is capped at ${max} entries; dropping the rest.`);
      break;
    }
    if (typeof item !== "string" || item.trim().length === 0) {
      warnings.push(`settings.requireScreenshotTable.${field}[${index}] must be a non-empty string; ignoring it.`);
      continue;
    }
    out.push(item.trim().slice(0, maxChars));
  }
  return out;
}

/** Normalize a raw `requireScreenshotTable` value (DB JSON or `.gittensory.yml`) into a validated config. Never
 *  throws: malformed fields fall back to the default (disabled/empty), matching every other settings normalizer
 *  in this codebase. */
export function normalizeScreenshotTableGateConfig(input: unknown, warnings: string[]): ScreenshotTableGateConfig {
  if (input === undefined || input === null) return { ...DEFAULT_SCREENSHOT_TABLE_GATE, whenLabels: [], whenPaths: [] };
  if (typeof input !== "object" || Array.isArray(input)) {
    warnings.push("settings.requireScreenshotTable must be an object; using the default (disabled).");
    return { ...DEFAULT_SCREENSHOT_TABLE_GATE, whenLabels: [], whenPaths: [] };
  }
  const record = input as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SCREENSHOT_TABLE_GATE.enabled;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    warnings.push(`settings.requireScreenshotTable.enabled must be a boolean; using the default "${DEFAULT_SCREENSHOT_TABLE_GATE.enabled}".`);
  }
  const action = isScreenshotTableGateAction(record.action)
    ? record.action
    : (() => {
        if (record.action !== undefined) warnings.push(`settings.requireScreenshotTable.action must be one of close, request_changes, comment; using the default "close".`);
        return DEFAULT_SCREENSHOT_TABLE_GATE.action;
      })();
  const message = typeof record.message === "string" && record.message.trim().length > 0 ? record.message.trim() : undefined;
  if (record.message !== undefined && message === undefined) {
    warnings.push("settings.requireScreenshotTable.message must be a non-empty string; using the default message.");
  }
  return {
    enabled,
    whenLabels: normalizeStringList(record.whenLabels, "whenLabels", MAX_LABELS, MAX_LABEL_CHARS, warnings),
    whenPaths: normalizeStringList(record.whenPaths, "whenPaths", MAX_PATHS, MAX_PATH_CHARS, warnings),
    action,
    ...(message !== undefined ? { message } : {}),
  };
}

/** Linear-time markdown table separator check. The previous single-regex form nested unbounded `\\s*` inside a
 *  repeated group and could catastrophically backtrack on attacker-controlled PR bodies; this splits on `|` and
 *  validates each cell independently instead. */
const TABLE_SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/;

function isMarkdownTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !/-{3,}/.test(trimmed)) return false;
  const withoutEdgePipes = trimmed.replace(/^\|/, "").replace(/\|$/, "").trim();
  const cells = withoutEdgePipes.split("|");
  return cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
}

/** True when `body` contains at least one markdown TABLE region (`| ... |` header + separator row) whose cells
 *  embed image markup — either `![alt](url)` or an `<img ...>` tag — inside the table. A screenshot pasted as a
 *  bare inline image OUTSIDE any table does not count (the contract requires captioned thumbnails INSIDE a
 *  table, not a wall of raw images). Deliberately simple/regex-based (no markdown AST dependency) — false
 *  negatives fail toward "no table found" (in-scope PRs still need a real table), false positives fail toward
 *  "table found" (never blocks a PR that plausibly complied); both directions are acceptable for a
 *  first-pass deterministic heuristic that a maintainer can always override by hand. */
export function hasImageBearingMarkdownTable(body: string | null | undefined): boolean {
  if (!body) return false;
  const lines = body.split(/\r?\n/);
  const tableRowPattern = /^\s*\|.*\|\s*$/;
  const imagePattern = /!\[[^\]]*\]\([^)]+\)|<img\b[^>]*>/i;
  for (let i = 0; i < lines.length - 1; i += 1) {
    // `i < lines.length - 1` guarantees both indices are in bounds; the `?? ""` fallbacks only exist to
    // satisfy noUncheckedIndexedAccess and are never actually reached.
    /* v8 ignore next -- defensive: the loop bound above guarantees lines[i] always exists here. */
    const header = lines[i] ?? "";
    /* v8 ignore next -- defensive: the loop bound above guarantees lines[i + 1] always exists here. */
    const separator = lines[i + 1] ?? "";
    if (!tableRowPattern.test(header) || !isMarkdownTableSeparatorRow(separator)) continue;
    // Found a table (header + separator). Scan its body rows (until a blank line or a non-table line) for
    // image markup in any cell.
    let j = i + 2;
    /* v8 ignore next -- defensive: the `j < lines.length` guard above guarantees lines[j] always exists here. */
    while (j < lines.length && tableRowPattern.test(lines[j] ?? "")) {
      if (imagePattern.test(lines[j] ?? "")) return true;
      j += 1;
    }
  }
  return false;
}

/** True when `body` has a large inline image OUTSIDE of any markdown table — a common way contributors dodge
 *  the table requirement (paste screenshots directly into the body instead of inside a captioned table row). */
export function hasImageOutsideTable(body: string | null | undefined): boolean {
  if (!body) return false;
  const lines = body.split(/\r?\n/);
  const tableRowPattern = /^\s*\|.*\|\s*$/;
  const imagePattern = /!\[[^\]]*\]\([^)]+\)|<img\b[^>]*>/i;
  return lines.some((line) => imagePattern.test(line) && !tableRowPattern.test(line));
}

/** True when any changed file path is an image under a scoped path (a screenshot committed to the repo instead
 *  of uploaded to the PR body via GitHub's CDN, per the contract). `scopedPaths` should be the SAME glob list
 *  used for scope matching (`whenPaths`) so this only flags an image landing where visual work is expected —
 *  not an unrelated asset (e.g. a favicon) added anywhere else in the repo. Empty `scopedPaths` (no path scoping
 *  configured) checks every changed path. */
export function hasCommittedImageFile(changedFiles: string[], scopedPaths: string[]): boolean {
  return changedFiles.some((file) => {
    const lower = file.toLowerCase();
    if (!IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
    return scopedPaths.length === 0 || matchesAny(file, scopedPaths);
  });
}

/** True when the PR is IN SCOPE for the gate: it carries one of `config.whenLabels` OR touches a path matching
 *  one of `config.whenPaths`. Both empty ⇒ every PR is in scope (an operator who enables the gate with no
 *  scoping at all wants it enforced everywhere). Only one non-empty list configured ⇒ that list alone decides
 *  scope (the other, empty list can never exclude a PR the configured one matched). */
export function isScreenshotTableGateInScope(config: ScreenshotTableGateConfig, prLabels: string[], changedFiles: string[]): boolean {
  if (config.whenLabels.length === 0 && config.whenPaths.length === 0) return true;
  const wantedLabels = new Set(config.whenLabels.map((label) => label.toLowerCase()));
  const labelMatch = config.whenLabels.length > 0 && prLabels.some((label) => wantedLabels.has(label.toLowerCase()));
  const pathMatch = config.whenPaths.length > 0 && changedFiles.some((file) => matchesAny(file, config.whenPaths));
  return labelMatch || pathMatch;
}

export const DEFAULT_SCREENSHOT_CONTRACT_MESSAGE =
  "This pull request changes UI/visual code but its description is missing a before/after screenshot table. " +
  "Every changed page/feature needs a **markdown table** with a before column and an after column, each cell a " +
  "clickable thumbnail (uploaded to the PR, not committed to the repo) with a caption below — for example:\n\n" +
  "| Before | After |\n| --- | --- |\n| [![before](url)](url) — caption | [![after](url)](url) — caption |\n\n" +
  "Please resubmit with the table filled in.";

export type ScreenshotTableGateResult = {
  violated: boolean;
  reason: string | null;
};

const NO_VIOLATION: ScreenshotTableGateResult = { violated: false, reason: null };

/** PURE evaluator. Off (`enabled: false`) or out-of-scope (no configured label/path match) ⇒ no violation. In
 *  scope AND (no image-bearing table in the body OR an image pasted outside a table OR a committed image file
 *  under a scoped path) ⇒ violated, with the configured (or default) templated message as the reason. */
export function evaluateScreenshotTableGate(input: {
  config: ScreenshotTableGateConfig;
  prBody: string | null | undefined;
  prLabels: string[];
  changedFiles: string[];
}): ScreenshotTableGateResult {
  const { config } = input;
  if (!config.enabled) return NO_VIOLATION;
  if (!isScreenshotTableGateInScope(config, input.prLabels, input.changedFiles)) return NO_VIOLATION;
  const hasTable = hasImageBearingMarkdownTable(input.prBody);
  const outsideTable = hasImageOutsideTable(input.prBody);
  const committedImage = hasCommittedImageFile(input.changedFiles, config.whenPaths);
  if (hasTable && !outsideTable && !committedImage) return NO_VIOLATION;
  return { violated: true, reason: config.message ?? DEFAULT_SCREENSHOT_CONTRACT_MESSAGE };
}
