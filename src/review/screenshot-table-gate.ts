import { matchesAny } from "../signals/change-guardrail";
import type { ScreenshotTableGateAction, ScreenshotTableGateConfig } from "../types";

export type { ScreenshotTableGateAction, ScreenshotTableGateConfig } from "../types";

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
const MAX_MATRIX_DIMENSION = 12;
const MAX_MATRIX_TOKEN_CHARS = 40;

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
  requireViewports: [],
  requireThemes: [],
};

const VALID_ACTIONS: readonly ScreenshotTableGateAction[] = ["close", "advisory"];

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
  if (input === undefined || input === null) return { ...DEFAULT_SCREENSHOT_TABLE_GATE, whenLabels: [], whenPaths: [], requireViewports: [], requireThemes: [] };
  if (typeof input !== "object" || Array.isArray(input)) {
    warnings.push("settings.requireScreenshotTable must be an object; using the default (disabled).");
    return { ...DEFAULT_SCREENSHOT_TABLE_GATE, whenLabels: [], whenPaths: [], requireViewports: [], requireThemes: [] };
  }
  const record = input as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SCREENSHOT_TABLE_GATE.enabled;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    warnings.push(`settings.requireScreenshotTable.enabled must be a boolean; using the default "${DEFAULT_SCREENSHOT_TABLE_GATE.enabled}".`);
  }
  const action = isScreenshotTableGateAction(record.action)
    ? record.action
    : (() => {
        if (record.action !== undefined) warnings.push(`settings.requireScreenshotTable.action must be "close" or "advisory" (#4110 removed request_changes/comment as dead config surface); using the default "close".`);
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
    requireViewports: normalizeStringList(record.requireViewports, "requireViewports", MAX_MATRIX_DIMENSION, MAX_MATRIX_TOKEN_CHARS, warnings),
    requireThemes: normalizeStringList(record.requireThemes, "requireThemes", MAX_MATRIX_DIMENSION, MAX_MATRIX_TOKEN_CHARS, warnings),
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

const IMAGE_CELL_PATTERN = /!\[[^\]]*\]\([^)]+\)|<img\b[^>]*>/i;

/** One data row of a detected markdown table: the cell texts in source order (leading/trailing pipes and
 *  whitespace stripped). Deliberately a SEPARATE table-detection pass from {@link hasImageBearingMarkdownTable}
 *  rather than a shared refactor of it -- that function's exact behavior is pinned by existing tests, and this
 *  one needs actual cell contents (not just "does some cell have an image"), so duplicating its short
 *  header+separator detection loop keeps both independently simple instead of risking a regression in either
 *  from a shared-code change. */
function extractTableRows(body: string | null | undefined): string[][] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const tableRowPattern = /^\s*\|.*\|\s*$/;
  const rows: string[][] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    /* v8 ignore next -- defensive: the loop bound above guarantees lines[i] always exists here. */
    const header = lines[i] ?? "";
    /* v8 ignore next -- defensive: the loop bound above guarantees lines[i + 1] always exists here. */
    const separator = lines[i + 1] ?? "";
    if (!tableRowPattern.test(header) || !isMarkdownTableSeparatorRow(separator)) continue;
    let j = i + 2;
    /* v8 ignore next -- defensive: the `j < lines.length` guard above guarantees lines[j] always exists here. */
    while (j < lines.length && tableRowPattern.test(lines[j] ?? "")) {
      /* v8 ignore next -- defensive: same loop-bound guarantee as above. */
      const line = lines[j] ?? "";
      const cells = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
      rows.push(cells);
      j += 1;
    }
  }
  return rows;
}

/** One (viewport, theme) combination the matrix must cover. `theme: null` means the theme dimension isn't
 *  required at all (a repo can require viewport coverage without color-mode coverage). */
export type ScreenshotMatrixPair = { viewport: string; theme: string | null };

/** The full set of (viewport, theme) pairs `config` requires, or `[]` when matrix mode is off. Matrix mode
 *  turns on via `requireViewports` alone -- `requireThemes` with an empty `requireViewports` has no effect,
 *  since there is no viewport to cross it against. */
export function requiredScreenshotMatrixPairs(config: ScreenshotTableGateConfig): ScreenshotMatrixPair[] {
  if (config.requireViewports.length === 0) return [];
  if (config.requireThemes.length === 0) return config.requireViewports.map((viewport) => ({ viewport, theme: null }));
  const pairs: ScreenshotMatrixPair[] = [];
  for (const viewport of config.requireViewports) {
    for (const theme of config.requireThemes) pairs.push({ viewport, theme });
  }
  return pairs;
}

/** True when some row's first cell (the row LABEL, e.g. "Desktop · Light") mentions both `pair.viewport` and
 *  `pair.theme` (case-insensitive substring match -- tolerant of whatever separator character the contributor
 *  used between them) AND that row has at least two image-bearing cells among the rest (before + after). */
function rowSatisfiesMatrixPair(row: string[], pair: ScreenshotMatrixPair): boolean {
  // `?? ""` only exists to satisfy noUncheckedIndexedAccess -- `extractTableRows`'s `.split("|")` always
  // produces at least one cell, even for an empty-string row, so `row[0]` is never actually undefined here.
  /* v8 ignore next -- defensive: see the comment above. */
  const label = (row[0] ?? "").toLowerCase();
  if (!label.includes(pair.viewport.toLowerCase())) return false;
  if (pair.theme !== null && !label.includes(pair.theme.toLowerCase())) return false;
  const imageCells = row.slice(1).filter((cell) => IMAGE_CELL_PATTERN.test(cell)).length;
  return imageCells >= 2;
}

/** The subset of `pairs` with NO satisfying row anywhere in `body`'s tables. Empty ⇒ full coverage. */
export function missingScreenshotMatrixPairs(body: string | null | undefined, pairs: ScreenshotMatrixPair[]): ScreenshotMatrixPair[] {
  if (pairs.length === 0) return [];
  const rows = extractTableRows(body);
  return pairs.filter((pair) => !rows.some((row) => rowSatisfiesMatrixPair(row, pair)));
}

function formatMatrixPair(pair: ScreenshotMatrixPair): string {
  return pair.theme === null ? pair.viewport : `${pair.viewport} · ${pair.theme}`;
}

/** Build the rejection reason for a matrix violation, naming exactly which viewport/theme combinations are
 *  still missing a real before+after pair -- so the contributor knows precisely what to add, not just that
 *  "something" is missing. */
export function buildScreenshotMatrixMessage(missing: ScreenshotMatrixPair[]): string {
  const list = missing.map(formatMatrixPair).join(", ");
  const dimensionLabel = missing.some((pair) => pair.theme !== null) ? "viewport × theme" : "viewport";
  return (
    "This pull request changes UI/visual code but its screenshot evidence is incomplete. Every required " +
    `${dimensionLabel} combination needs its own before/after image pair in a labeled table row (e.g. ` +
    '"Desktop · Light | before | after"). Still missing: ' +
    `${list}.\n\nPlease resubmit with the remaining rows filled in.`
  );
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

/** PURE evaluator. Off (`enabled: false`) or out-of-scope (no configured label/path match) ⇒ no violation.
 *  `botCaptureSatisfied` ⇒ no violation regardless of mode (an automated capture is equivalent to a
 *  hand-authored table, and the bot doesn't (yet) shoot a full viewport/theme matrix -- see #4535's scope note).
 *
 *  Two modes, chosen by whether `config.requireViewports` is non-empty (#4535):
 *  - MATRIX mode: every required (viewport, theme) pair (`requiredScreenshotMatrixPairs`) must have a labeled
 *    before/after row. Violated ⇒ the reason names exactly which pairs are still missing.
 *  - PRESENCE mode (the original #2006 behavior, unchanged): in scope AND (no image-bearing table in the body
 *    OR an image pasted outside a table OR a committed image file under a scoped path) ⇒ violated, with the
 *    configured (or default) templated message as the reason. */
export function evaluateScreenshotTableGate(input: {
  config: ScreenshotTableGateConfig;
  prBody: string | null | undefined;
  prLabels: string[];
  changedFiles: string[];
  /** #4110: true when the bot's own before/after capture pipeline (review.visual.enabled) already produced a
   *  REAL before+after render pair for this PR's current head — evidence equivalent to a hand-authored table.
   *  A successful automated capture satisfies the gate on its own, ahead of (and regardless of) the body-table
   *  anti-gaming checks below — those exist to stop a contributor from FAKING compliance without the bot's
   *  help, which doesn't apply once the bot has already proven the change visually. Absent/false ⇒
   *  byte-identical to pre-#4110 behavior (body-table evidence only). */
  botCaptureSatisfied?: boolean | undefined;
}): ScreenshotTableGateResult {
  const { config } = input;
  if (!config.enabled) return NO_VIOLATION;
  if (!isScreenshotTableGateInScope(config, input.prLabels, input.changedFiles)) return NO_VIOLATION;
  if (input.botCaptureSatisfied === true) return NO_VIOLATION;

  const matrixPairs = requiredScreenshotMatrixPairs(config);
  if (matrixPairs.length > 0) {
    const missing = missingScreenshotMatrixPairs(input.prBody, matrixPairs);
    if (missing.length === 0) return NO_VIOLATION;
    return { violated: true, reason: config.message ?? buildScreenshotMatrixMessage(missing) };
  }

  const hasTable = hasImageBearingMarkdownTable(input.prBody);
  const outsideTable = hasImageOutsideTable(input.prBody);
  const committedImage = hasCommittedImageFile(input.changedFiles, config.whenPaths);
  if (hasTable && !outsideTable && !committedImage) return NO_VIOLATION;
  return { violated: true, reason: config.message ?? DEFAULT_SCREENSHOT_CONTRACT_MESSAGE };
}
