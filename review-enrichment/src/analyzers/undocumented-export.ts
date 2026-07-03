// Public-API undocumented-export scan (#2035, part of #1499). Flags exports NEWLY ADDED to a package's public
// entrypoint (an `index.*` barrel) that ship with no adjacent doc comment — undocumented public surface a reviewer
// should notice. It reads added export declarations from the diff, then fetches the changed entrypoint at headSha
// (one authed contents fetch) to confirm, against the FINAL file, that each added export has no preceding
// JSDoc/line comment. Deliberately conservative + fail-safe: only DIRECT `export function|const|let|var|class|
// interface|type|enum NAME` declarations in `index.*` files (re-export lists and `export *` are ignored, since they
// aggregate symbols documented at their definition); a missing token/head-sha, an unresolvable repo slug, or any
// fetch error yields no finding rather than an error.
import type { EnrichRequest, UndocumentedExportFinding } from "../types.js";

const GITHUB_API = "https://api.github.com";
const MAX_FILES = 10;
const MAX_FINDINGS = 30;
const MAX_FETCH_BYTES = 1_000_000;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// A public entrypoint barrel — an `index.<js/ts>` source file. Declaration (.d.ts), test, and generated output are
// excluded: they are not the hand-authored public surface this scan is about.
const ENTRYPOINT_RE = /(?:^|\/)index\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_RE = /(?:\.d\.ts$|\.min\.|\.test\.|\.spec\.|__tests__\/|(?:^|\/)(?:dist|build|vendor)\/)/;
// A DIRECT exported declaration and its symbol name (matched on the line body, without the diff `+`). Leading
// whitespace is allowed so an indented top-level export — TS only permits `export` at module scope or inside a
// `namespace`/`module` block, both public API — is still matched.
const EXPORT_DECL_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

interface ScanOptions {
  signal?: AbortSignal;
}

/** Added export declarations in a unified diff, each with its NEW-file line number. Walks hunk headers to track the
 *  new-file cursor; only `+` lines that declare a direct export are collected (`-`/`\` lines never advance the new
 *  cursor, `+++`/`---` headers are ignored). Pure. */
export function parseAddedExports(patch: string): Array<{ symbol: string; newLine: number }> {
  const out: Array<{ symbol: string; newLine: number }> = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      if (!raw.startsWith("+++")) {
        const decl = EXPORT_DECL_RE.exec(raw.slice(1));
        if (decl) out.push({ symbol: decl[1]!, newLine });
        newLine += 1;
      }
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      newLine += 1; // context line advances the new-file cursor
    }
  }
  return out;
}

/** True when the line at `lineIndex` (0-based) has an adjacent doc comment directly above it — a block comment
 *  ending in `*​/` (JSDoc or plain) or a `//` line — allowing only blank lines in between. Conservative: ANY
 *  preceding comment counts as documented, so only an export with code (or nothing) directly above is flagged. Pure. */
export function hasPrecedingDocComment(lines: string[], lineIndex: number): boolean {
  let i = lineIndex - 1;
  // Skip blank lines AND decorator lines (`@Component()`) between the export and its doc comment, so a documented
  // decorated `export class` is not falsely flagged.
  while (i >= 0) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("@")) {
      i -= 1;
      continue;
    }
    break;
  }
  if (i < 0) return false;
  const above = lines[i]!.trim();
  // Require a COMMENT-ONLY line: a `//` line comment or a block-comment opener/body/terminator (starts with `/*`
  // or `*`). A code line with a TRAILING block comment starts with code, so it is not treated as documentation.
  return above.startsWith("//") || above.startsWith("/*") || above.startsWith("*");
}

async function readBoundedText(resp: Response, signal?: AbortSignal): Promise<string | null> {
  const length = Number(resp.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FETCH_BYTES) return null;
  if (!resp.body) return null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FETCH_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Analyzer entrypoint: for each changed `index.*` entrypoint, fetch it at headSha and flag added exports with no
 *  adjacent doc comment. Fail-safe — returns no finding on a missing token/head-sha, bad slug, or fetch error. */
export async function scanUndocumentedExport(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<UndocumentedExportFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  // Require EXACTLY `owner/repo`: a 3+ segment value would otherwise query the wrong repo instead of failing safe.
  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    // `vnd.github.raw` returns the file's raw bytes from the Contents API — the same media type the sibling
    // github-light analyzer doc-comment-drift.ts uses to fetch a file at headSha.
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const entrypoints = files
    .filter((file) => file.patch && ENTRYPOINT_RE.test(file.path) && !SKIP_RE.test(file.path))
    .slice(0, MAX_FILES);

  const findings: UndocumentedExportFinding[] = [];
  for (const file of entrypoints) {
    if (options.signal?.aborted) break;
    const added = parseAddedExports(file.patch!);
    if (!added.length) continue;

    let content: string | null = null;
    try {
      const path = file.path.split("/").map(encodeURIComponent).join("/");
      const resp = await fetchFn(
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(headSha)}`,
        { headers, signal: options.signal },
      );
      if (resp.ok) content = await readBoundedText(resp, options.signal);
    } catch {
      content = null;
    }
    if (!content) continue;
    if (options.signal?.aborted) break; // an abort during the fetch should suppress this file's findings too

    const lines = content.split("\n");
    for (const { symbol, newLine } of added) {
      const idx = newLine - 1;
      const line = lines[idx];
      if (line === undefined) continue;
      // Confirm the export still declares this symbol at that line in the FINAL file (patch/head aligned); a mismatch
      // means the line moved or changed, so fail closed and skip it.
      if (EXPORT_DECL_RE.exec(line)?.[1] !== symbol) continue;
      if (hasPrecedingDocComment(lines, idx)) continue;
      findings.push({ file: file.path, line: newLine, symbol });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
