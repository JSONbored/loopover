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

// package.json keys whose values LOOK like ranges but are not dependency specifiers: the manifest's own
// `version`, engine constraints (`"node": ">=18"` in engines is legitimate and extremely common), and
// publishConfig's dist-tag. A finite, documented deny-list — the same trade-off dependency-scan.ts makes for
// its line-based parse — so the notorious `engines` false positive cannot fire on its well-known keys.
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

  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (!line.startsWith("+") || isDiffFileHeaderLine(line)) {
      // A `\ No newline at end of file` marker is not a content line, so it must not advance the
      // new-file line counter — mirrors the sibling analyzers (e.g. iac-misconfig.ts).
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine++;
      continue;
    }

    const body = line.slice(1);
    if (body.length > MAX_LINE_CHARS) {
      newLine++;
      continue;
    }

    const match = NPM_LINE_RE.exec(body.trim());
    if (match && !NON_DEPENDENCY_KEYS.has(match[1]!)) {
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
