// Accessibility-regression analyzer (#2026, the a11y half of the #1499 epic 'accessibility and i18n regression'
// idea; the i18n half is a separate bounty). Flags common accessibility regressions in added JSX/HTML markup:
// an <img> without alt, an onClick handler added to a non-interactive element without a keyboard handler or
// role, a form control with no way to associate a label, and a positive tabindex (which breaks natural tab
// order). Pure compute over added diff lines, no network. Only self-contained tags (opening `<` through closing
// `>` on the same added line) are matched, so a tag whose attributes wrap across lines is not scanned — this
// keeps the analyzer diff-local and free of false positives from partial tags.
import type { A11yFinding, EnrichRequest } from "../types.js";
import { isTestPath } from "./test-ratio.js";

export const MAX_FINDINGS = 25;
export const MAX_LINE_CHARS = 2000;

const MARKUP_PATH_RE = /\.(?:jsx|tsx|html?|vue)$/i;

// Elements with built-in interactive semantics — an onClick here needs no extra keyboard wiring.
const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "option",
  "textarea",
  "summary",
  "label",
  "audio",
  "video",
  "details",
  "dialog",
  "menuitem",
]);

// <input> types that are never associated with a visible label (hidden fields, buttons that carry their own text).
const LABELLESS_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

const TAG_RE = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
const ALT_RE = /\balt\s*=/i;
const ONCLICK_RE = /\bonClick\s*=/;
// `onKeyPress` is deliberately NOT accepted here — it is deprecated and being removed by browsers, so relying on
// it alone should still trip the rule; only `onKeyDown`/`onKeyUp`/`role` satisfy the keyboard-accessible check.
const KEY_HANDLER_OR_ROLE_RE = /\bonKeyDown\s*=|\bonKeyUp\s*=|\brole\s*=/;
const TYPE_ATTR_RE = /\btype\s*=\s*["']?(\w+)/i;
const LABEL_ASSOC_RE = /\bid\s*=|\baria-label\s*=|\baria-labelledby\s*=/i;
const TABINDEX_RE = /\btabindex\s*=\s*["'{]?\s*(-?\d+)/i;

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^(?:\/\/|\/\*|\*|<!--|\{\/\*)/.test(trimmed);
}

function isMarkupPath(path: string): boolean {
  return MARKUP_PATH_RE.test(path) && !isTestPath(path);
}

/** Classify one self-contained `<tag ...>` opening tag for a11y regressions. Pure. Returns every rule the tag
 *  trips (a single tag can trip more than one, e.g. a clickable div with a positive tabindex). */
export function detectA11yIssues(
  tagName: string,
  attrs: string,
): Array<A11yFinding["rule"]> {
  const tag = tagName.toLowerCase();
  const rules: Array<A11yFinding["rule"]> = [];

  if (tag === "img" && !ALT_RE.test(attrs)) {
    rules.push("img-alt");
  }

  if (
    ONCLICK_RE.test(attrs) &&
    !INTERACTIVE_TAGS.has(tag) &&
    !KEY_HANDLER_OR_ROLE_RE.test(attrs)
  ) {
    rules.push("click-events-have-key-events");
  }

  if (tag === "input" || tag === "textarea" || tag === "select") {
    const typeMatch = TYPE_ATTR_RE.exec(attrs);
    const type = typeMatch?.[1]?.toLowerCase();
    const skippable = tag === "input" && type !== undefined && LABELLESS_INPUT_TYPES.has(type);
    if (!skippable && !LABEL_ASSOC_RE.test(attrs)) {
      rules.push("label-control");
    }
  }

  const tabindexMatch = TABINDEX_RE.exec(attrs);
  if (tabindexMatch && Number(tabindexMatch[1]) > 0) {
    rules.push("positive-tabindex");
  }

  return rules;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for accessibility regressions, line-cited via hunk headers. Pure. */
export function scanPatchForA11y(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): A11yFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isMarkupPath(path)) return [];

  const findings: A11yFinding[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (!line.startsWith("+")) {
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine++;
      continue;
    }

    const body = line.slice(1);
    if (body.length <= MAX_LINE_CHARS && !isCommentLine(body)) {
      TAG_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TAG_RE.exec(body)) !== null) {
        const [, tagName, attrs] = match;
        if (tagName === undefined || attrs === undefined) continue;
        for (const rule of detectA11yIssues(tagName, attrs)) {
          findings.push({ file: path, line: newLine, rule });
          if (findings.length >= maxFindings) return findings;
        }
      }
    }
    newLine++;
  }

  return findings;
}

/** Analyzer entrypoint: scan every changed markup file's added lines for accessibility regressions. */
export async function scanA11y(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<A11yFinding[]> {
  const findings: A11yFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForA11y(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
