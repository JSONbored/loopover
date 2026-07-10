// Accessibility regression analyzer (#2026). Flags common a11y regressions in newly added JSX/HTML markup:
// images without alt text, click-only handlers on non-interactive elements, unlabeled form controls, and
// positive tabindex values. Pure compute over added lines in .jsx/.tsx/.html/.vue files, no network.
import type { A11yFinding, EnrichRequest } from "../types.js";
import { isTestPath } from "./test-ratio.js";
import { DEFAULT_MAX_FINDINGS, DEFAULT_MAX_LINE_CHARS } from "./limits.js";
import { isBasicCommentLine } from "./diff-lines.js";

const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const MAX_LINE_CHARS = DEFAULT_MAX_LINE_CHARS;

const MARKUP_PATH_RE = /\.(?:tsx|jsx|html|vue)$/i;

const POSITIVE_TABINDEX_RE =
  /\btabIndex\s*=\s*\{\s*([1-9]\d*)\s*\}|\btabindex\s*=\s*["']([1-9]\d*)["']/i;
const IMG_TAG_RE = /<img\b/i;
const ALT_ATTR_RE = /\balt\s*=/i;
const ON_CLICK_RE = /\bonClick\s*=/;
const KEYBOARD_HANDLER_RE = /\bonKey(?:Down|Up|Press)\s*=/;
const INTERACTIVE_TAG_RE = /<(?:button|a)\b/i;
const INTERACTIVE_ROLE_RE =
  /\brole\s*=\s*["'](?:button|link|menuitem|tab|switch|checkbox|radio)["']/i;
const NON_INTERACTIVE_CLICK_TARGET_RE =
  /<(?:div|span|p|li|td|tr|section|article|header|footer|main|nav)\b/i;
const FORM_CONTROL_RE = /<(?:input|select|textarea)\b/i;
const LABEL_ASSOC_RE = /\b(?:aria-label|aria-labelledby|id)\s*=|<label\b/i;

// Layers the HTML `<!--` comment form and JSX-adjacent `import`/`from` statements on top of the shared
// `isBasicCommentLine` base (#4611) — this analyzer scans markup (.jsx/.tsx/.html/.vue) where an import
// line is boilerplate, not a markup regression candidate, and HTML comments are common.
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return isBasicCommentLine(line) || /^(?:<!--|import\b|from\b)/.test(trimmed);
}

function isMarkupPath(path: string): boolean {
  return MARKUP_PATH_RE.test(path) && !isTestPath(path);
}

/** Classify one added markup line for an a11y regression, or null. Pure. */
export function detectA11yRegression(line: string): A11yFinding["rule"] | null {
  if (isCommentLine(line) || line.length > MAX_LINE_CHARS) return null;

  if (POSITIVE_TABINDEX_RE.test(line)) return "positive-tabindex";

  if (IMG_TAG_RE.test(line) && !ALT_ATTR_RE.test(line)) return "img-alt";

  if (ON_CLICK_RE.test(line)) {
    const hasKeyboard = KEYBOARD_HANDLER_RE.test(line);
    const isInteractive =
      INTERACTIVE_TAG_RE.test(line) || INTERACTIVE_ROLE_RE.test(line);
    if (
      !hasKeyboard &&
      !isInteractive &&
      NON_INTERACTIVE_CLICK_TARGET_RE.test(line)
    ) {
      return "click-events-have-key-events";
    }
  }

  if (FORM_CONTROL_RE.test(line) && !LABEL_ASSOC_RE.test(line)) {
    return "label-control";
  }

  return null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for a11y regressions, line-cited via hunk headers. Pure. */
export function scanPatchForA11yRegression(
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
    if (line.startsWith("+")) {
      const body = line.slice(1);
      const rule = detectA11yRegression(body);
      if (rule) {
        findings.push({ file: path, line: newLine, rule });
        if (findings.length >= maxFindings) return findings;
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }

  return findings;
}

/** Analyzer entrypoint: scan markup files for accessibility regressions. */
export async function scanA11yRegression(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<A11yFinding[]> {
  const findings: A11yFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForA11yRegression(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
