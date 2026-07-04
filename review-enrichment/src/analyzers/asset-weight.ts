// Image/binary asset weight-delta analyzer (#1506). Flags a PR that commits or grows a heavy image/font/binary
// blob — repo + CDN/cold-start bloat the textual diff hides behind "Binary files differ". Binary sizes are not in
// the patch, so this is the one analyzer that needs the GitHub API: the git tree at headSha (and baseSha, for
// modified files) is fetched with the request's short-lived token — one recursive call returns every blob's size,
// which also sidesteps the Contents API's 1 MB cap. Pure size arithmetic after that; no external service.
// Fail-safe: returns [] without a token/headSha or when the head tree fetch is not OK; growth findings require a
// matching base size.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  AssetWeightFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

const MAX_FINDINGS = 50; // keep the brief bounded after evaluating every changed binary candidate
const MAX_PATH_SIZE_LOOKUPS = 50; // fallback Contents API calls when a recursive tree is truncated
const THRESHOLD_BYTES = 100 * 1024; // flag a newly-added blob >= 100 KB, or growth >= 100 KB
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

// Extensions that are genuinely binary (text formats like .svg/.json are excluded — their bytes are in the diff).
const BINARY_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tiff",
  "tif",
  "ico",
  "webp",
  "avif",
  "heic",
  "heif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "mov",
  "avi",
  "webm",
  "mkv",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "xz",
  "zst",
  "pdf",
  "psd",
  "ai",
  "sketch",
  "fig",
  "xcf",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "wasm",
  "node",
  "jar",
  "class",
]);

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

// A single repo path segment (owner or name): word chars, dot, dash only. Whole-segment `.`/`..` are rejected
// separately so they can't traverse. A commit SHA: hex only — we only ever fetch a real object, never an arbitrary ref.
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

/** True when a path's extension is a genuinely binary asset (image/font/media/archive/binary). Text formats
 *  like .svg/.json are deliberately excluded — their bytes are already in the textual diff. Pure. */
export function isBinaryAsset(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && BINARY_EXTS.has(path.slice(dot + 1).toLowerCase());
}

type EnrichFile = NonNullable<EnrichRequest["files"]>[number];

/** The base-side path to measure growth against: the same path for a modified/changed file, the pre-rename
 *  path for a rename, and null for anything else (added/removed have no comparable base size). Pure. */
export function basePathForGrowth(file: EnrichFile): string | null {
  if (file.status === "modified" || file.status === "changed") return file.path;
  if (file.status === "renamed") return file.previousPath || null;
  return null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

/** Percent-encode each segment of a repo path for a Contents API URL, rejecting (null) an empty path or any
 *  empty / `.` / `..` segment so a crafted path can never traverse out of the tree. Pure. */
export function encodeRepoPath(path: string): string | null {
  const segments = path.split("/");
  if (!path || segments.some((seg) => !seg || seg === "." || seg === "..")) {
    return null;
  }
  return segments.map(encodeURIComponent).join("/");
}

async function fetchGithubJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  options: ScanOptions,
  endpointCategory: "github-trees" | "github-contents",
): Promise<T | null> {
  const fetchOptions = {
    endpointCategory,
    headers: githubHeaders(token),
    signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "asset-weight",
    subcall: endpointCategory,
    maxBytes:
      endpointCategory === "github-trees" ? 4 * 1024 * 1024 : 256 * 1024,
    maxCallsPerCategory:
      endpointCategory === "github-contents" ? MAX_PATH_SIZE_LOOKUPS : 2,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Parse `owner/repo`, rejecting anything that isn't exactly two safe segments — no extra `/`, no `.`/`..`
 *  traversal, no query/fragment characters. This stops a hostile `repoFullName` from redirecting the
 *  token-bearing request to another repository. Returns null when unsafe. */
function parseRepo(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  for (const seg of [owner, repo]) {
    if (!seg || seg === "." || seg === ".." || !REPO_SEGMENT.test(seg)) {
      return null;
    }
  }
  return { owner: owner!, repo: repo! };
}

/** Fetch every blob's byte size in the repo's git tree at `sha`. One recursive call. Empty map on an invalid SHA
 *  or a non-OK reply. `owner`/`repo` are validated by the caller; every segment is URL-encoded here (defense in
 *  depth) so nothing user-derived can break out of the intended API path. */
async function fetchTreeSizes(
  owner: string,
  repo: string,
  sha: string,
  token: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  options: ScanOptions,
): Promise<{ sizes: Map<string, number>; truncated: boolean }> {
  const sizes = new Map<string, number>();
  if (!SHA_RE.test(sha)) return { sizes, truncated: false };
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`;
  const json = await fetchGithubJson<{
    tree?: Array<{ path?: string; type?: string; size?: number }>;
    truncated?: boolean;
  }>(url, token, fetchImpl, signal, options, "github-trees");
  if (!json) return { sizes, truncated: false };
  for (const entry of json.tree ?? []) {
    if (entry.type === "blob" && typeof entry.size === "number" && entry.path) {
      sizes.set(entry.path, entry.size);
    }
  }
  return { sizes, truncated: json.truncated === true };
}

async function fetchPathSizes(
  owner: string,
  repo: string,
  sha: string,
  token: string,
  paths: Iterable<string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  options: ScanOptions,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!SHA_RE.test(sha)) return sizes;
  for (const path of [...new Set(paths)].slice(0, MAX_PATH_SIZE_LOOKUPS)) {
    const encodedPath = encodeRepoPath(path);
    if (!encodedPath) continue;
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`;
    const json = await fetchGithubJson<
      { type?: string; size?: number } | unknown[]
    >(url, token, fetchImpl, signal, options, "github-contents");
    if (!json) continue;
    if (!Array.isArray(json) && typeof json.size === "number") {
      sizes.set(path, json.size);
    }
  }
  return sizes;
}

async function fetchRelevantSizes(
  owner: string,
  repo: string,
  sha: string,
  token: string,
  paths: Iterable<string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  options: ScanOptions,
): Promise<Map<string, number>> {
  const tree = await fetchTreeSizes(
    owner,
    repo,
    sha,
    token,
    fetchImpl,
    signal,
    options,
  );
  if (!tree.truncated) return tree.sizes;
  return fetchPathSizes(
    owner,
    repo,
    sha,
    token,
    paths,
    fetchImpl,
    signal,
    options,
  );
}

/** Analyzer entrypoint: flag heavy binary assets the PR adds or grows past the threshold. Pure size arithmetic over
 *  the GitHub git tree; fail-safe (returns [] without a token or on a failed head tree fetch). */
export async function scanAssetWeight(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<AssetWeightFinding[]> {
  const token = req.githubToken;
  if (!token || !req.headSha) return [];
  const repo = parseRepo(req.repoFullName);
  if (!repo) return [];

  const binaries = (req.files ?? []).filter(
    (f) => f.status !== "removed" && isBinaryAsset(f.path),
  );
  if (!binaries.length) return [];

  const headSizes = await fetchRelevantSizes(
    repo.owner,
    repo.repo,
    req.headSha,
    token,
    binaries.map((file) => file.path),
    fetchImpl,
    options.signal,
    options,
  );
  const basePaths = binaries.flatMap((file) => basePathForGrowth(file) ?? []);
  const needBase = binaries.some((f) => basePathForGrowth(f) !== null);
  const baseSizes =
    needBase && req.baseSha
      ? await fetchRelevantSizes(
          repo.owner,
          repo.repo,
          req.baseSha,
          token,
          basePaths,
          fetchImpl,
          options.signal,
          options,
        )
      : new Map<string, number>();

  const findings: AssetWeightFinding[] = [];
  for (const file of binaries) {
    const bytes = headSizes.get(file.path);
    if (typeof bytes !== "number") continue;

    if (file.status === "added" || file.status === "copied") {
      if (bytes >= THRESHOLD_BYTES) {
        findings.push({
          path: file.path,
          bytes,
          deltaBytes: bytes,
          status: "added",
        });
      }
      continue;
    }

    const basePath = basePathForGrowth(file);
    if (basePath) {
      const baseBytes = baseSizes.get(basePath);
      if (typeof baseBytes !== "number") continue;
      const deltaBytes = bytes - baseBytes;
      if (deltaBytes < THRESHOLD_BYTES) continue;
      findings.push({
        path: file.path,
        bytes,
        deltaBytes,
        status: "grown",
      });
    }
  }
  return findings
    .sort((a, b) => b.deltaBytes - a.deltaBytes)
    .slice(0, MAX_FINDINGS);
}
