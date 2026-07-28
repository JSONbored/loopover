#!/usr/bin/env node
// #9499: every `agent-regate-pr` producer must carry `prCreatedAt`.
//
// `jobClaimSortKey` (src/selfhost/queue-common.ts) sorts regate jobs by the PR's own `createdAt` ascending —
// the ONE real oldest-first ordering mechanism the queue has. A producer that omits `prCreatedAt` falls back
// to `LEGACY_AGENT_REGATE_SORT_BASE_MS + prNumber` (~9.5e11), which sorts AHEAD of every genuinely older 2026
// PR (~1.78e12). So an omission does not degrade the ordering — it INVERTS it, silently, for that producer's
// jobs, and five of eight producers had done exactly that.
//
// A type-level guard cannot express this: `prCreatedAt` is legitimately optional on `JobMessage` (a producer
// that truly has no PR record must still be able to enqueue), so making it required would break the
// deliberate exceptions rather than catch the accidental ones. This check reads the producer sites instead
// and requires each to either pass the field or be explicitly allowlisted with a reason — the same
// "an exception must be stated, not inferred from absence" shape as check-dead-source-files.ts's entry points.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCAN_ROOTS = ["src"] as const;
const SOURCE_PATTERN = /(?<!\.d)\.ts$/;
const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|dist|dist-test)(?:\/|$)/;

/** Hard ceiling on how far a producer's object literal may be scanned, purely so a malformed/unbalanced file
 *  cannot make this walk the rest of the module. The real bound is the literal's own closing brace — see
 *  {@link producerObjectText}. */
const PRODUCER_SCAN_CEILING_LINES = 60;

/**
 * Producers that deliberately omit `prCreatedAt`, each with the reason. Keyed `file:marker`, where the marker
 * is a distinctive substring of the producer's own `deliveryId` so the entry survives line-number churn.
 */
const ALLOWED_OMISSIONS: ReadonlyMap<string, string> = new Map([
  [
    "src/api/routes.ts:manual-regate:",
    "The maintainer-triggered manual re-gate route enqueues at priority 99 to jump the queue ON PURPOSE — an operator asking for one PR now is exactly the case oldest-first should not apply to. It also has no PR record in hand (the body carries only repoFullName + prNumber).",
  ],
]);

export type RegateSortKeyViolation = { file: string; line: number; snippet: string };

function defaultListSourceFiles(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true })
      .map(String)
      .filter((entry) => SOURCE_PATTERN.test(entry) && !EXCLUDED_SEGMENT.test(entry))
      .map((entry) => `${root}/${entry}`);
  } catch {
    return [];
  }
}

/**
 * Pure over its inputs: finds every `type: "agent-regate-pr"` producer whose enqueued object does not carry
 * `prCreatedAt` within the following {@link PRODUCER_WINDOW_LINES} lines, minus the allowlisted exceptions.
 * `listSourceFiles`/`readFile` are injectable so tests can simulate a fresh offender without touching the tree.
 */
export function findRegateSortKeyViolations(
  options: {
    roots?: readonly string[];
    listSourceFiles?: (root: string) => string[];
    readFile?: (file: string) => string;
    allowedOmissions?: ReadonlyMap<string, string>;
  } = {},
): RegateSortKeyViolation[] {
  const {
    roots = SCAN_ROOTS,
    listSourceFiles = defaultListSourceFiles,
    readFile = (file: string) => readFileSync(file, "utf8"),
    allowedOmissions = ALLOWED_OMISSIONS,
  } = options;

  const violations: RegateSortKeyViolation[] = [];
  for (const root of roots) {
    for (const file of listSourceFiles(root)) {
      const lines = readFile(file).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes('type: "agent-regate-pr"')) continue;
        const window = producerObjectText(lines, index);
        if (window.includes("prCreatedAt")) continue;
        const allowed = [...allowedOmissions.keys()].some((key) => {
          const [allowedFile, marker] = splitAllowKey(key);
          return allowedFile === file && marker !== "" && window.includes(marker);
        });
        if (allowed) continue;
        violations.push({ file, line: index + 1, snippet: line.trim() });
      }
    }
  }
  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

/**
 * The text of the object literal that OWNS the `type: "agent-regate-pr"` line at `startIndex`, bounded by that
 * literal's own closing brace rather than a fixed line count.
 *
 * A fixed window is subtly wrong here and produced a real false negative while this check was being written:
 * two producers sitting within a few lines of each other let the FIRST one's `prCreatedAt` satisfy the scan
 * for the SECOND one's, so removing a field from one of them was not caught. Tracking brace depth means each
 * producer is judged on its own literal and nothing else.
 */
function producerObjectText(lines: readonly string[], startIndex: number): string {
  const collected: string[] = [];
  let depth = 0;
  for (let i = startIndex; i < Math.min(lines.length, startIndex + PRODUCER_SCAN_CEILING_LINES); i += 1) {
    const line = lines[i] ?? "";
    collected.push(line);
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
    }
    // Depth goes negative at the `}` that closes the literal this `type:` line sits inside — that line is the
    // last one belonging to this producer.
    if (depth < 0) break;
  }
  return collected.join("\n");
}

/** Split `path/to/file.ts:marker-text` on the LAST colon that precedes the marker — a marker may itself
 *  contain colons (`manual-regate:`), so a naive split on the first or last colon gets it wrong. */
function splitAllowKey(key: string): [string, string] {
  const boundary = key.indexOf(".ts:");
  if (boundary === -1) return [key, ""];
  return [key.slice(0, boundary + ".ts".length), key.slice(boundary + ".ts:".length)];
}

function main(): void {
  const violations = findRegateSortKeyViolations();
  if (violations.length === 0) {
    process.stdout.write("agent-regate-pr sort keys: OK\n");
    return;
  }
  process.stderr.write(`Found ${violations.length} agent-regate-pr producer(s) missing prCreatedAt (#9499):\n`);
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}:${violation.line} — ${violation.snippet}\n`);
  }
  process.stderr.write(
    "\nAn omitted prCreatedAt does not merely lose the ordering — it INVERTS it: jobClaimSortKey falls back to\n" +
      "LEGACY_AGENT_REGATE_SORT_BASE_MS + prNumber (~9.5e11), which sorts ahead of every real 2026 PR (~1.78e12).\n" +
      "Pass the PR's createdAt, or — if the producer genuinely must jump the queue — add it to ALLOWED_OMISSIONS\n" +
      "in scripts/check-regate-sort-key.ts with the reason.\n",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
