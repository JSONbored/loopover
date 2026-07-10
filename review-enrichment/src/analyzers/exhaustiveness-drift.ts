// Enum / literal-union exhaustiveness-drift analyzer (#2028). Flags when a PR adds a new enum member or string-literal
// union variant but a switch that previously covered every old member still omits the new one. Fetches changed type
// files and other changed consumer files at headSha (injected fetch), reverse-applies the patch to recover the
// pre-PR member set, and only reports high-confidence misses (explicit enum/union cases, no default branch). Bounded
// file-fetch caps; fail-safe on missing token/headSha, bad slug, or fetch errors.
import type { EnrichRequest, ExhaustivenessFinding } from "../types.js";
import { githubHeaders } from "../github-headers.js";
import { reconstructOldContent } from "./reconstruct-old-content.js";
import { isDiffFileHeaderLine } from "./diff-lines.js";
import { isTestPath } from "./test-ratio.js";
import { DEFAULT_MAX_FINDINGS } from "./limits.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_FILES = 10;
const MAX_FETCHES = 10;
const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const MAX_FETCH_BYTES = 1_000_000;
const MAX_SWITCH_HEADER_LINES = 25;
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_RE = /(?:\.d\.ts$|\.min\.|(?:^|\/)(?:dist|build|vendor)\/)/;

const ENUM_DECL_RE = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{/;
const ENUM_MEMBER_RE = /^\s*([A-Za-z_$][\w$]*)\s*(?:=\s*[^,{]+)?,?\s*(?:\/\/.*)?$/;
const UNION_DECL_RE = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*/;
const UNION_MEMBER_RE = /^\s*\|\s*["']([^"']+)["']\s*/;
const DEFAULT_CASE_RE = /^\s*default\s*:/;

interface ScanOptions {
  signal?: AbortSignal;
}

interface AddedMemberCandidate {
  file: string;
  unionName: string;
  addedMember: string;
  line: number;
  kind: "enum" | "union";
}

function escapeRegExp(value: string): string {
  return value.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");
}

function isScannablePath(path: string): boolean {
  return SOURCE_RE.test(path) && !SKIP_RE.test(path) && !isTestPath(path);
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

async function fetchFileAtHead(
  owner: string,
  repo: string,
  path: string,
  headSha: string,
  token: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  try {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const resp = await fetchFn(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(headSha)}`,
      { headers: githubHeaders(token, { raw: true }), signal },
    );
    if (!resp.ok) return null;
    return await readBoundedText(resp, signal);
  } catch {
    return null;
  }
}

/** Walk a unified diff and collect newly added enum/union members with their declaring type name and new-file line. */
export function parseAddedTypeMembers(
  patch: string,
): Array<{ unionName: string; addedMember: string; line: number; kind: "enum" | "union" }> {
  const out: Array<{ unionName: string; addedMember: string; line: number; kind: "enum" | "union" }> = [];
  let newLine = 0;
  let enumName: string | null = null;
  let unionName: string | null = null;
  let enumDepth = 0;

  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      enumName = null;
      unionName = null;
      enumDepth = 0;
      continue;
    }

    const isAdd = raw.startsWith("+") && !isDiffFileHeaderLine(raw);
    const isContext = !raw.startsWith("-") && !raw.startsWith("\\") && !isDiffFileHeaderLine(raw);
    if (!isAdd && !isContext) continue;

    const line = isAdd ? raw.slice(1) : raw.startsWith(" ") ? raw.slice(1) : raw;
    const enumDecl = ENUM_DECL_RE.exec(line);
    if (enumDecl) {
      enumName = enumDecl[1]!;
      unionName = null;
      enumDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    }
    const unionDecl = UNION_DECL_RE.exec(line);
    if (unionDecl) {
      unionName = unionDecl[1]!;
      enumName = null;
      enumDepth = 0;
    }

    if (isAdd) {
      if (enumName && enumDepth >= 0) {
        const member = ENUM_MEMBER_RE.exec(line);
        if (member && member[1] !== "const") {
          out.push({ unionName: enumName, addedMember: member[1]!, line: newLine, kind: "enum" });
        }
      }
      const unionMember = UNION_MEMBER_RE.exec(line);
      if (unionName && unionMember) {
        out.push({ unionName, addedMember: unionMember[1]!, line: newLine, kind: "union" });
      }
      newLine += 1;
    } else {
      if (enumName) {
        enumDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (enumDepth <= 0 && line.includes("}")) enumName = null;
      }
      newLine += 1;
    }
  }
  return out;
}

/** Extract the member names of a TS enum declaration from file content. Returns null when the enum is not found. */
export function extractEnumMembers(content: string, enumName: string): Set<string> | null {
  const decl = new RegExp(`(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+${escapeRegExp(enumName)}\\s*\\{`).exec(
    content,
  );
  if (!decl) return null;
  const start = decl.index + decl[0].length;
  let depth = 1;
  let i = start;
  const members = new Set<string>();
  let chunk = "";
  while (i < content.length && depth > 0) {
    const ch = content[i]!;
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth === 1) chunk += ch;
    i += 1;
  }
  for (const part of chunk.split(",")) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const name = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (name) members.add(name[1]!);
  }
  return members.size ? members : null;
}

/** Extract string-literal members from a `type Name = ...` alias. Returns null when not found or ambiguous. */
export function extractUnionMembers(content: string, unionName: string): Set<string> | null {
  const decl = new RegExp(
    `(?:export\\s+)?type\\s+${escapeRegExp(unionName)}\\s*=\\s*([^;]+);`,
    "s",
  ).exec(content);
  if (!decl) return null;
  const literals = [...decl[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
  return literals.length ? new Set(literals) : null;
}

interface SwitchGap {
  line: number;
}

/** Find a switch that covered all `oldMembers` but omits `addedMember`. Skips switches with a default branch. */
export function findExhaustivenessGap(
  content: string,
  kind: "enum" | "union",
  typeName: string,
  oldMembers: Set<string>,
  addedMember: string,
): SwitchGap | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*switch\s*\(/.test(lines[i]!)) continue;
    const block = extractSwitchBlock(lines, i);
    if (!block) continue;
    if (block.some((l) => DEFAULT_CASE_RE.test(l))) continue;
    const cases = kind === "enum" ? collectEnumCases(block, typeName) : collectUnionCases(block);
    if (!oldMembers.size || ![...oldMembers].every((m) => cases.has(m))) continue;
    if (cases.has(addedMember)) continue;
    return { line: i + 1 };
  }
  return null;
}

function extractSwitchBlock(lines: string[], switchLine: number): string[] | null {
  let depth = 0;
  let started = false;
  const block: string[] = [];
  for (let i = switchLine; i < lines.length; i++) {
    if (!started && i - switchLine >= MAX_SWITCH_HEADER_LINES) return null;
    const line = lines[i]!;
    block.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") depth -= 1;
    }
    if (started && depth === 0) return block;
  }
  return null;
}

function collectEnumCases(block: string[], enumName: string): Set<string> {
  const cases = new Set<string>();
  const qualified = new RegExp(`case\\s+${escapeRegExp(enumName)}\\.([A-Za-z_$][\\w$]*)\\s*:`);
  const bare = /case\s+([A-Za-z_$][\w$]*)\s*:/;
  for (const line of block) {
    const q = qualified.exec(line);
    if (q) cases.add(q[1]!);
    else {
      const b = bare.exec(line);
      if (b) cases.add(b[1]!);
    }
  }
  return cases;
}

function collectUnionCases(block: string[]): Set<string> {
  const cases = new Set<string>();
  const re = /case\s+["']([^"']+)["']\s*:/;
  for (const line of block) {
    const match = re.exec(line);
    if (match) cases.add(match[1]!);
  }
  return cases;
}

/** Analyzer entrypoint. Fail-safe — returns no finding on missing token/headSha or fetch errors. */
export async function scanExhaustivenessDrift(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<ExhaustivenessFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const candidates: AddedMemberCandidate[] = [];
  for (const file of files) {
    if (!file.patch || !isScannablePath(file.path)) continue;
    for (const item of parseAddedTypeMembers(file.patch)) {
      candidates.push({ file: file.path, ...item });
    }
  }
  if (!candidates.length) return [];

  const scannableFiles = files.filter((f) => f.patch && isScannablePath(f.path)).slice(0, MAX_FILES);
  const contentCache = new Map<string, string | null>();
  let fetches = 0;

  const loadFile = async (path: string, patch?: string): Promise<string | null> => {
    if (contentCache.has(path)) return contentCache.get(path) ?? null;
    if (fetches >= MAX_FETCHES) {
      contentCache.set(path, null);
      return null;
    }
    fetches += 1;
    const content = await fetchFileAtHead(owner, repo, path, headSha, githubToken, fetchFn, options.signal);
    contentCache.set(path, content);
    return content;
  };

  const findings: ExhaustivenessFinding[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (findings.length >= MAX_FINDINGS) break;
    if (!scannableFiles.some((f) => f.path === candidate.file)) continue;

    const typeFile = files.find((f) => f.path === candidate.file);
    if (!typeFile?.patch) continue;
    const headContent = await loadFile(candidate.file, typeFile.patch);
    if (!headContent) continue;
    const oldContent = reconstructOldContent(headContent, typeFile.patch);
    if (!oldContent) continue;

    const extract = candidate.kind === "enum" ? extractEnumMembers : extractUnionMembers;
    const oldMembers = extract(oldContent, candidate.unionName);
    const newMembers = extract(headContent, candidate.unionName);
    if (!oldMembers || !newMembers) continue;
    if (!newMembers.has(candidate.addedMember) || oldMembers.has(candidate.addedMember)) continue;

    for (const consumer of scannableFiles) {
      const consumerContent =
        consumer.path === candidate.file ? headContent : await loadFile(consumer.path, consumer.patch);
      if (!consumerContent) continue;
      const gap = findExhaustivenessGap(
        consumerContent,
        candidate.kind,
        candidate.unionName,
        oldMembers,
        candidate.addedMember,
      );
      if (!gap) continue;
      const key = `${consumer.path}:${gap.line}:${candidate.unionName}:${candidate.addedMember}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file: candidate.file,
        line: candidate.line,
        unionName: candidate.unionName,
        addedMember: candidate.addedMember,
        ...(consumer.path !== candidate.file ? { consumerFile: consumer.path } : {}),
      });
      break;
    }
  }
  return findings;
}
