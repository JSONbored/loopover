// Overly-broad dependency version-range analyzer (#2036). Flags newly-added/changed npm dependency specifiers
// that use dangerously loose ranges — `*`/`x` wildcards, the `latest` dist-tag, unbounded `>=`/`>` ranges, and
// bare-major ranges (`18`, `18.x`) — instead of a pinned/caret/tilde range. A loose range lets any future
// publish (including a compromised one) flow into the next install: a reproducibility and supply-chain drift
// risk. Distinct from the vuln/typosquat analyzers: this judges only the SPECIFIER, never the package. Pure
// compute over added package.json patch lines, no registry call. Like the sibling dependency-scan.ts, parsing
// is a line-based heuristic (not a full manifest parse) — good enough to classify the specifiers a PR adds
// without resolving the whole tree.
import type { EnrichRequest, LooseRangeFinding } from "../types.js";
import { isDiffFileHeaderLine } from "./diff-lines.js";

const MAX_FINDINGS = 20;
const MAX_LINE_CHARS = 2000;

// `"name": "spec"` on an added line, same shape the sibling dependency-scan.ts keys on.
const NPM_LINE_RE = /^"([^"]+)"\s*:\s*"([^"]+)"/;
// An `npm:pkg@range` alias — classify the range part, exactly as dependency-scan.ts unwraps it.
const NPM_ALIAS_RE = /^npm:(?:@[^/]+\/[^@]+|[^@]+)@(.+)$/;

// A `"section": {` object header — the lightweight per-hunk section state that decides whether a
// `"name": "spec"` line is a dependency entry at all.
const SECTION_HEADER_RE = /^"([^"]+)"\s*:\s*\{/;
// The manifest blocks whose entries ARE dependency specifiers. Inside these, every entry is classified with
// no suppression — a real dependency named `npm` or `node` is still a dependency.
const DEPENDENCY_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);
// Fallback for hunks where no section header is visible (a diff that starts mid-block): keys whose values
// LOOK like ranges but are usually not dependency specifiers — the manifest's own `version`, engine
// constraints (`"node": ">=18"` in engines is legitimate and extremely common), and publishConfig's
// dist-tag. Only consulted when the enclosing section is UNKNOWN; when the section is visible, membership
// in DEPENDENCY_SECTIONS decides instead, so `"dependencies": { "npm": "*" }` is still flagged.
const NON_DEPENDENCY_KEYS = new Set([
  "version",
  "node",
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "vscode",
  "tag",
  "access",
]);

const UNBOUNDED_GTE_RE = /^>=?\s*\d/;
const UPPER_BOUND_RE = /<\s*=?\s*\d/;
const BARE_MAJOR_RE = /^\d+(?:\.[xX*])?(?:\.[xX*])?$/;

/** Classify one raw npm version specifier; null when the range is not one of the loose kinds. Pure. */
export function classifyRange(spec: string): LooseRangeFinding["kind"] | null {
  const alias = NPM_ALIAS_RE.exec(spec);
  const range = (alias ? alias[1]! : spec).trim();
  if (range === "*" || range === "x" || range === "X") return "wildcard";
  if (range === "latest") return "latest";
  if (UNBOUNDED_GTE_RE.test(range) && !UPPER_BOUND_RE.test(range)) {
    return "unbounded-gte";
  }
  if (BARE_MAJOR_RE.test(range)) return "bare";
  return null;
}

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one package.json patch for loose specifiers on ADDED lines. Pure. */
export function scanPatchForLooseRanges(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): LooseRangeFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];

  const findings: LooseRangeFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  // The enclosing manifest section, tracked from added AND context lines (both describe the new file).
  // null = unknown (top level, or a hunk that starts mid-block without its section header in view).
  let section: string | null = null;

  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      // Hunks can jump anywhere in the file — section state from a previous hunk must never leak into
      // the next one, or a hunk starting inside engines could inherit a stale "dependencies" state.
      section = null;
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;

    const isAddedContent = line.startsWith("+") && !isDiffFileHeaderLine(line);
    const isContext =
      !line.startsWith("+") && !line.startsWith("-") && !line.startsWith("\\");

    if (isContext) {
      const trimmed = line.slice(1).trim();
      const header = SECTION_HEADER_RE.exec(trimmed);
      if (header) section = header[1]!;
      else if (trimmed.startsWith("}")) section = null;
      newLine++;
      continue;
    }
    if (!isAddedContent) {
      // A `\ No newline at end of file` marker and a removed line are not new-file content lines, so they
      // must not advance the new-file line counter — mirrors the sibling analyzers (e.g. iac-misconfig.ts).
      // Removed lines describe the OLD file only, so they never touch section state either.
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine++;
      continue;
    }

    const body = line.slice(1);
    if (body.length > MAX_LINE_CHARS) {
      newLine++;
      continue;
    }

    const trimmed = body.trim();
    const header = SECTION_HEADER_RE.exec(trimmed);
    if (header) {
      section = header[1]!;
      newLine++;
      continue;
    }
    if (trimmed.startsWith("}")) {
      section = null;
      newLine++;
      continue;
    }

    const match = NPM_LINE_RE.exec(trimmed);
    if (match) {
      // Section-aware suppression: inside a known dependency block, EVERY entry is a dependency (a package
      // really named `npm` or `node` included). Inside any other known block (engines, publishConfig,
      // scripts, …) nothing is a dependency. Only when the section is unknown does the key-name fallback
      // heuristic apply.
      const suppressed =
        section !== null
          ? !DEPENDENCY_SECTIONS.has(section)
          : NON_DEPENDENCY_KEYS.has(match[1]!);
      if (!suppressed) {
        const kind = classifyRange(match[2]!);
        if (kind) {
          findings.push({
            file: path,
            line: newLine,
            package: match[1]!,
            range: match[2]!,
            kind,
          });
          if (findings.length >= maxFindings) return findings;
        }
      }
    }

    newLine++;
  }

  return findings;
}

/** Analyzer entrypoint: added package.json specifier lines → loose-range findings. No network. */
export async function scanLooseRanges(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<LooseRangeFinding[]> {
  const findings: LooseRangeFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    const basename = file.path.split("/").pop() ?? file.path;
    if (!file.patch || basename !== "package.json") continue;
    for (const finding of scanPatchForLooseRanges(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
