// Non-inclusive / banned-terminology analyzer (#2031). Flags non-inclusive terms newly added in identifiers or
// comments (whitelist/blacklist, master/slave) and suggests the neutral replacement — a config-driven house-style
// signal. Pure compute over added lines, no network. Stateless per line: each added line is tokenized on its own,
// so there is no comment/string state to track. Precision-first: matching is TOKEN-based (camelCase + snake_case
// + non-alphanumeric splits), so `masterclass`/`postmaster`/`mastermind` never match on a substring — only a real
// `master` token (in `master`, `master_node`, `masterNode`, or a comment word) does. URLs are blanked first so a
// link path segment cannot trip a finding. Line-cited via hunk headers, mirroring the sibling local analyzers.
import type { EnrichRequest, TerminologyFinding } from "../types.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

// A bounded, in-file term → neutral-suggestion table (self-host operators can read the whole policy here). Keys
// are the lowercased TOKENS the tokenizer produces. A key matches whenever it appears as a WHOLE token after
// tokenization — which, by design, includes camelCase/snake_case compound components: `slaveNodes` →
// [slave, nodes] and `blacklistIDs` → [blacklist, ids] ARE flagged, because a non-inclusive term in an
// identifier is exactly what this analyzer exists to surface. What is NOT matched is a DIFFERENT word that
// merely contains the letters: `slavery`, `mastered`, `masterclass`, and `postmaster` each tokenize to a single
// distinct token, so they never match. Inflections we do want are listed explicitly (below) rather than fuzzy-
// stemmed, so there is no accidental over-match on an unlisted form.
const TERMS: Record<string, string> = {
  whitelist: "allowlist",
  whitelists: "allowlists",
  whitelisted: "allowlisted",
  whitelisting: "allowlisting",
  blacklist: "denylist",
  blacklists: "denylists",
  blacklisted: "denylisted",
  blacklisting: "denylisting",
  master: "main or primary",
  slave: "replica or secondary",
  slaves: "replicas or secondaries",
};

const URL_RE = /https?:\/\/\S+|\bwww\.\S+/gi;

/** Split an identifier/word run into its constituent lowercased words at camelCase and acronym boundaries.
 *  `masterNode` → [master, node]; `HTTPServer` → [http, server]; `whitelist` → [whitelist]. Pure. */
function splitCamel(run: string): string[] {
  return run
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // lower/digit → Upper: masterNode → master Node
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // acronym → Word: HTTPServer → HTTP Server
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

/** Tokenize a line into lowercased words: split on any non-alphanumeric run (so `master_node`, `"master"`, and
 *  `master-branch` all separate), then split each run on camelCase boundaries — so a compound identifier like
 *  `slaveNodes` becomes [slave, nodes] and its non-inclusive component is surfaced. Pure. */
export function tokenizeLine(line: string): string[] {
  return line
    .replace(URL_RE, " ")
    .split(/[^A-Za-z0-9]+/)
    .flatMap(splitCamel);
}

/** The banned terms present on a line, de-duplicated, each with its suggestion. Pure. */
export function detectTerminology(
  line: string,
): Array<{ term: string; suggestion: string }> {
  const seen = new Set<string>();
  const hits: Array<{ term: string; suggestion: string }> = [];
  for (const token of tokenizeLine(line)) {
    const suggestion = TERMS[token];
    if (suggestion && !seen.has(token)) {
      seen.add(token);
      hits.push({ term: token, suggestion });
    }
  }
  return hits;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for banned terminology, line-cited via hunk headers. Pure. */
export function scanPatchForTerminology(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): TerminologyFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const findings: TerminologyFinding[] = [];
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
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        for (const hit of detectTerminology(body)) {
          findings.push({ file: path, line: newLine, term: hit.term, suggestion: hit.suggestion });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line — do not advance the cursor
      // (same class as the actions-pin / iac-misconfig fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's added lines for banned terminology. */
export async function scanTerminology(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<TerminologyFinding[]> {
  const findings: TerminologyFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForTerminology(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
