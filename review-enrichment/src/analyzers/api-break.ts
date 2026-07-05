// Breaking-API-change analyzer (#1510, part of #1499). A no-checkout headless reviewer sees only the diff, so it
// cannot tell that a PR DROPS or RENAMES a symbol a package's public entrypoint used to export — a semver-major
// break that reaches DOWNSTREAM consumers, distinct from the in-repo caller-impact analyzer. This fills that gap
// purely from the patch: for each changed PUBLIC-ENTRYPOINT file (index/mod/main/public-api barrels) it collects
// the exported names on removed (`-`) lines and on added (`+`) lines, and reports a name present in the REMOVED
// set but absent from the ADDED set — i.e. the public surface lost it (a removal or a rename). Deliberately
// CONSERVATIVE and fail-safe: a same-name edit (a signature/value change re-adds the name) is never flagged, only
// exact whole-name loss is; a non-entrypoint file is out of scope (that is the caller-impact analyzer's job).
// Deterministic, no network, no token. Reports file, old-file line, and symbol only — never surrounding code.
import type { ApiBreakFinding, EnrichRequest } from "../types.js";

const MAX_ENTRYPOINTS = 25; // cap changed entrypoint files scanned per PR
const MAX_FINDINGS = 25; // keep the brief bounded

// Files whose top-level exports form a package's PUBLIC surface: barrel/entry modules only. Restricting to these
// entrypoint basenames keeps the signal conservative — a removed export in an internal module is not a downstream
// break. Declaration (`.d.ts`) and test/spec files are excluded: their exports are not a shipped public API.
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_RE = /(?:\.d\.ts$|\.min\.|\.test\.|\.spec\.|__tests__\/|(?:^|\/)tests?\/)/;
const ENTRYPOINT_BASENAME = /^(?:index|mod|main|public-api|public_api|api)$/;

// A named top-level export DECLARATION at column 0 (an indented `export` inside a namespace/module block is
// intentionally not matched). `const enum` precedes the bare `const` alternative so the enum name, not `enum`, is
// captured.
const EXPORT_DECL_RE =
  /^export\s+(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class|const\s+enum|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
// `export * as ns from "..."` binds one namespace name; `export * from "..."` binds none and is not matched.
const EXPORT_STAR_AS_RE = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/;
// A single-line `export { a, b as c } [from "..."]` / `export type { T } from "..."` list. Aliases resolve to the
// PUBLIC (right-hand) name. A brace list spanning multiple lines is intentionally not parsed (fail-safe).
const EXPORT_NAMED_RE = /^export\s+(?:type\s+)?\{([^}]*)\}/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** True when a changed path is a package PUBLIC ENTRYPOINT (barrel/entry basename, source ext, not decl/test). Pure. */
export function isPublicEntrypoint(path: string): boolean {
  if (!SOURCE_RE.test(path) || SKIP_RE.test(path)) return false;
  const base = path.split("/").pop() ?? path;
  const stem = base.replace(SOURCE_RE, "");
  return ENTRYPOINT_BASENAME.test(stem);
}

/** Every exported symbol name a single source line declares or re-exports at the top level. Handles declarations,
 *  `export default`, single-line `export { … }`/`export type { … }` (aliases resolve to the PUBLIC name), and
 *  `export * as ns from`. A bare `export * from "…"` binds no nameable symbol and yields none. Pure. */
export function exportedNames(line: string): string[] {
  const decl = EXPORT_DECL_RE.exec(line);
  if (decl) return [decl[1]!];
  if (/^export\s+default\b/.test(line)) return ["default"];
  const starAs = EXPORT_STAR_AS_RE.exec(line);
  if (starAs) return [starAs[1]!];
  const named = EXPORT_NAMED_RE.exec(line);
  if (named) {
    const out: string[] = [];
    for (const raw of named[1]!.split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const parts = spec.split(/\s+as\s+/);
      const publicName = (parts[parts.length - 1] ?? "").trim();
      if (IDENT_RE.test(publicName)) out.push(publicName);
    }
    return out;
  }
  return [];
}

interface RemovedExport {
  symbol: string;
  line: number;
}

/** Removed/renamed exports in one entrypoint file's patch: names exported on a removed (`-`) line whose name is NOT
 *  re-exported on any added (`+`) line of the same file (a same-name edit re-adds it and is not a break). The
 *  old-file line counter advances over removed + context lines (never added lines) so the reported line is the
 *  symbol's pre-PR location. Pure. */
export function removedExports(patch: string): RemovedExport[] {
  const removed = new Map<string, number>();
  const added = new Set<string>();
  let oldLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      if (raw.startsWith("+++")) continue;
      for (const name of exportedNames(raw.slice(1))) added.add(name);
    } else if (raw.startsWith("-")) {
      if (raw.startsWith("---")) continue;
      for (const name of exportedNames(raw.slice(1))) {
        if (!removed.has(name)) removed.set(name, oldLine);
      }
      oldLine++;
    } else if (!raw.startsWith("\\")) {
      oldLine++;
    }
  }
  const out: RemovedExport[] = [];
  for (const [symbol, line] of removed) {
    if (!added.has(symbol)) out.push({ symbol, line });
  }
  return out;
}

/** Analyzer entrypoint: flag exported symbols a PR drops or renames from a public entrypoint — a downstream
 *  semver-major break. Deterministic and fail-safe: returns [] when no entrypoint file changed or on absent
 *  patches; bounded by entrypoint and finding caps. */
export async function scanApiBreak(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<ApiBreakFinding[]> {
  if (signal?.aborted) return [];
  const findings: ApiBreakFinding[] = [];
  let entrypoints = 0;
  for (const file of req.files ?? []) {
    if (signal?.aborted) break;
    if (!file.patch || !isPublicEntrypoint(file.path)) continue;
    if (entrypoints >= MAX_ENTRYPOINTS) break;
    entrypoints++;
    for (const removed of removedExports(file.patch)) {
      findings.push({ file: file.path, line: removed.line, symbol: removed.symbol });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
