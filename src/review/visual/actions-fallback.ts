// GitHub-Actions build-and-serve FALLBACK for a repo with no CI-produced preview deploy (#4112, part of the
// #3607 visual-capture convergence epic).
//
// preview-url.ts's discovery chain (Deployments API -> commit-check scan -> bot PR-comment scan) only ever
// finds a preview that SOME OTHER CI already produced. This module is the trusted half of a fork-safe,
// two-sided pipeline whose untrusted half is .github/workflows/visual-capture-fallback.yml:
//   1. gittensory DISPATCHES that workflow (`workflow_dispatch`, always resolved against the repo's default
//      branch) with the PR number + head SHA as inputs. A `workflow_dispatch` call always runs the DISPATCHED
//      ref's copy of the workflow file, so a contributor can never smuggle a modified workflow definition
//      through their own PR branch -- unlike a `pull_request`-triggered workflow, which runs the version
//      committed on the PR branch itself.
//   2. The dispatched job (contents: read, NO secrets -- see the workflow file's own header) checks out that
//      exact commit, builds the repo, serves the build on localhost INSIDE its own ephemeral runner, captures
//      each configured route with the runner's own preinstalled headless Chrome, and uploads the PNGs as a
//      GitHub Actions artifact. It never holds a credential of any kind, and it never needs one: the untrusted
//      code's network reach never leaves the runner's own localhost, so GitHub's stock per-job isolation is
//      already the full sandbox this needs -- no bespoke Firecracker/gVisor sandbox to build or maintain.
//   3. On completion, GitHub delivers a `workflow_run` webhook. The caller (queue processor) uses gittensory's
//      OWN, already-trusted installation token -- NEVER a token that passed through step 2's untrusted job --
//      to list and download that run's artifact via `fetchFallbackArtifactShots` below.
//
// The artifact's real download location is a short-lived, per-run SIGNED url GitHub hands back at request
// time (an *.actions.githubusercontent.com / *.blob.core.windows.net host today), not a fixed one -- unlike
// every other fetch in this codebase, which only ever talks to api.github.com or a *.workers.dev/*.pages.dev
// preview host. isGithubArtifactStorageUrl is the SSRF allowlist extension this genuinely new source needs:
// isSafeHttpUrl's general public-https safety, PLUS a closed host-suffix allowlist (mirrors preview-url.ts's
// own PREVIEW_HOST_SUFFIXES pattern), so a malformed or unexpected API response can never make gittensory's
// backend fetch an attacker-influenced or internal address.
//
// A `workflow_dispatch` run carries no natural PR association (unlike a `pull_request`-triggered run), so the
// dispatched workflow's `run-name:` embeds `pr=<number> sha=<full sha>` -- GitHub renders `run-name` from the
// dispatch inputs and surfaces the result as `workflow_run.display_title` in the completion webhook.
// parseFallbackRunCorrelation reads it back; a run whose title doesn't match this exact shape is ignored
// (fail-safe -- never guesses a PR from an unrelated run).
import { timeoutFetch, type GitHubRateLimitAdmissionKey } from "../../github/client";
import { sha256Hex } from "../../utils/crypto";
import { isSafeHttpUrl } from "../content-lane/safe-url";
import type { GitHubRepo } from "./preview-url";

const DEFAULT_TIMEOUT_MS = 20_000;
const API_VERSION = "2022-11-28";

/** The workflow file this module dispatches and whose completions it listens for. */
export const FALLBACK_WORKFLOW_FILE = "visual-capture-fallback.yml";
/** The workflow's declared `name:` -- cross-checked against `workflow_run.name` before acting on a completion. */
export const FALLBACK_WORKFLOW_NAME = "Gittensory Visual Capture Fallback";
/** The artifact name the dispatched workflow uploads its captured PNGs under. */
export const FALLBACK_ARTIFACT_NAME = "gittensory-visual-fallback";

// ---------------------------------------------------------------------------------------------------------
// SSRF allowlist extension: the artifact-download redirect target.
// ---------------------------------------------------------------------------------------------------------

/** Hosts GitHub's Actions artifact-download redirect resolves to. Closed allowlist, mirrors preview-url.ts's
 *  own PREVIEW_HOST_SUFFIXES pattern -- a public, non-attacker-controllable set of GitHub/Azure-owned hosts. */
const GITHUB_ARTIFACT_HOST_SUFFIXES = [".actions.githubusercontent.com", ".blob.core.windows.net"] as const;

/** True for an https URL on the GitHub Actions artifact-storage allowlist. Layers isSafeHttpUrl's general
 *  public/non-private-host safety UNDER the closed suffix allowlist -- both must hold. Used to validate the
 *  redirect `Location` the artifact-zip endpoint returns before this backend ever fetches it. */
export function isGithubArtifactStorageUrl(raw: string): boolean {
  if (!isSafeHttpUrl(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Unreachable via this public entry point: isSafeHttpUrl above already parsed `raw` with `new URL()` and
    // only returned true because that parse succeeded -- `new URL()` is deterministic, so the identical call
    // here can never throw. Retained (mirrors safe-url.ts's own defense-in-depth style) rather than trusting
    // that invariant silently.
    /* v8 ignore next -- @preserve unreachable, see comment above */
    return false;
  }
  const host = url.hostname.toLowerCase();
  return GITHUB_ARTIFACT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// ---------------------------------------------------------------------------------------------------------
// Dispatch: gittensory -> GitHub (workflow_dispatch), pinned to the default branch.
// ---------------------------------------------------------------------------------------------------------

/** Dispatch the fallback capture workflow for one PR. `ref` MUST be the repo's default branch (never the PR's
 *  own branch/SHA) -- that pinning is what makes a contributor's own workflow-file edits inert. Returns false
 *  (never throws) on any failure so a capture attempt can't sink a review; the caller degrades to "no preview
 *  yet" exactly like every other discovery source in this pipeline. */
export async function dispatchVisualCaptureFallback(params: {
  token: string;
  repo: GitHubRepo;
  ref: string;
  prNumber: number;
  headSha: string;
  routes: readonly string[];
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined;
}): Promise<boolean> {
  const base = `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}`;
  try {
    const headers = new Headers();
    headers.set("accept", "application/vnd.github+json");
    headers.set("content-type", "application/json");
    headers.set("user-agent", "gittensory/0.1");
    headers.set("x-github-api-version", API_VERSION);
    headers.set("authorization", `Bearer ${params.token}`);
    const response = await timeoutFetch(`${base}/actions/workflows/${FALLBACK_WORKFLOW_FILE}/dispatches`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ref: params.ref,
        inputs: {
          pr_number: String(params.prNumber),
          head_sha: params.headSha,
          routes: JSON.stringify([...params.routes]),
        },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      githubRateLimitAdmission: params.rateLimitAdmissionKey !== undefined,
      ...(params.rateLimitAdmissionKey ? { githubRateLimitAdmissionKey: params.rateLimitAdmissionKey } : {}),
    });
    if (!response.ok) {
      console.log(JSON.stringify({ event: "visual_fallback_dispatch_rejected", repo: `${params.repo.owner}/${params.repo.repo}`, pr: params.prNumber, status: response.status }));
    }
    return response.ok;
  } catch (error) {
    console.log(JSON.stringify({ event: "visual_fallback_dispatch_error", repo: `${params.repo.owner}/${params.repo.repo}`, pr: params.prNumber, message: String(error).slice(0, 200) }));
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Correlation: recover {prNumber, headSha} from a completed workflow_run's display_title.
// ---------------------------------------------------------------------------------------------------------

const RUN_NAME_PATTERN = /gittensory-visual-fallback pr=(\d+) sha=([0-9a-f]{40})/i;

/** Parse the `pr=<number> sha=<sha>` correlation this module's own `run-name:` embeds (see the workflow file)
 *  back out of a completed run's `display_title`. Returns null (fail-safe, never guesses) for anything that
 *  doesn't match this exact shape -- an unrelated workflow_run, a hand-triggered dispatch, or a malformed
 *  title all degrade to "ignore this run" rather than acting on an unverified correlation. */
export function parseFallbackRunCorrelation(displayTitle: string | undefined | null): { prNumber: number; headSha: string } | null {
  if (!displayTitle) return null;
  const match = RUN_NAME_PATTERN.exec(displayTitle);
  if (!match) return null;
  const prNumber = Number(match[1]);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return null;
  return { prNumber, headSha: (match[2] as string).toLowerCase() };
}

// ---------------------------------------------------------------------------------------------------------
// Minimal ZIP reader -- just enough to read a GitHub Actions artifact (STORED / DEFLATE entries only).
// ---------------------------------------------------------------------------------------------------------

export type ZipEntry = { name: string; data: Uint8Array };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_ZIP_COMMENT_BYTES = 65535;
const CENTRAL_DIR_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
// GitHub Actions artifacts hold at most a handful of files here (one per route x viewport); bound the walk
// regardless of what a hostile/corrupt central directory claims, so a crafted entryCount can't spin forever.
const MAX_ZIP_ENTRIES = 64;

async function inflateRawRaw(compressed: Uint8Array): Promise<Uint8Array | null> {
  try {
    // The cast only narrows the TYPE for the UI workspace's stricter DOM-lib BodyInit/BlobPart, which excludes
    // SharedArrayBuffer from ArrayBufferLike -- `compressed` is always a view over a plain (never shared)
    // ArrayBuffer here (subarray of bytes ultimately sourced from Response#arrayBuffer()), mirrors shot.ts's
    // own `png as Uint8Array<ArrayBuffer>` cast for the identical reason.
    const stream = new Blob([compressed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Read every file entry out of a well-formed ZIP archive (method 0 = stored, or 8 = raw DEFLATE -- the only
 *  two GitHub Actions' own artifact uploader produces). Anything else -- a truncated buffer, a bad signature,
 *  an unsupported compression method, an offset past the buffer end -- degrades that ONE entry (or the whole
 *  read) to being skipped/empty rather than throwing; this parses a REMOTE, only-indirectly-trusted byte
 *  stream (the fork-built artifact), so every read here is bounds-checked before use. */
export async function parseZipEntries(bytes: Uint8Array): Promise<ZipEntry[]> {
  try {
    if (bytes.byteLength < EOCD_MIN_SIZE) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const searchStart = Math.max(0, bytes.byteLength - EOCD_MIN_SIZE - MAX_ZIP_COMMENT_BYTES);
    let eocdOffset = -1;
    for (let i = bytes.byteLength - EOCD_MIN_SIZE; i >= searchStart; i--) {
      if (view.getUint32(i, true) === EOCD_SIGNATURE) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) return [];

    const entryCount = Math.min(view.getUint16(eocdOffset + 10, true), MAX_ZIP_ENTRIES);
    let centralDirOffset = view.getUint32(eocdOffset + 16, true);
    const entries: ZipEntry[] = [];
    const decoder = new TextDecoder();

    for (let i = 0; i < entryCount; i++) {
      if (centralDirOffset < 0 || centralDirOffset + CENTRAL_DIR_HEADER_SIZE > bytes.byteLength) break;
      if (view.getUint32(centralDirOffset, true) !== CENTRAL_DIR_SIGNATURE) break;
      const method = view.getUint16(centralDirOffset + 10, true);
      const compressedSize = view.getUint32(centralDirOffset + 20, true);
      const nameLen = view.getUint16(centralDirOffset + 28, true);
      const extraLen = view.getUint16(centralDirOffset + 30, true);
      const commentLen = view.getUint16(centralDirOffset + 32, true);
      const localHeaderOffset = view.getUint32(centralDirOffset + 42, true);
      const nameStart = centralDirOffset + CENTRAL_DIR_HEADER_SIZE;
      const nameEnd = nameStart + nameLen;
      const nextCentralDirOffset = nameEnd + extraLen + commentLen;
      if (nameEnd > bytes.byteLength) break;
      const name = decoder.decode(bytes.subarray(nameStart, nameEnd));

      if (
        localHeaderOffset >= 0 &&
        localHeaderOffset + LOCAL_HEADER_SIZE <= bytes.byteLength &&
        view.getUint32(localHeaderOffset, true) === LOCAL_FILE_SIGNATURE
      ) {
        const localNameLen = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
        const dataOffset = localHeaderOffset + LOCAL_HEADER_SIZE + localNameLen + localExtraLen;
        const dataEnd = dataOffset + compressedSize;
        if (dataOffset >= 0 && dataEnd <= bytes.byteLength) {
          const compressed = bytes.subarray(dataOffset, dataEnd);
          const data = method === 0 ? new Uint8Array(compressed) : method === 8 ? await inflateRawRaw(compressed) : null;
          if (data) entries.push({ name, data });
        }
      }
      centralDirOffset = nextCentralDirOffset;
    }
    return entries;
  } catch {
    // Every offset this loop reads is bounds-checked against bytes.byteLength before use, so this is a
    // defense-in-depth backstop against a read this function doesn't already know how to reject cleanly --
    // not a path a crafted or truncated buffer is expected to reach through the checks above.
    /* v8 ignore next -- @preserve defense-in-depth backstop, see comment above */
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Fetch: list the completed run's artifacts, resolve + validate its download location, extract PNGs.
// ---------------------------------------------------------------------------------------------------------

export type FallbackShot = { fileName: string; png: Uint8Array };

// Bounds a hostile/oversized artifact -- MAX_CONFIGURED_ROUTES (5, capture.ts) x 2 viewports x 2 themes,
// rounded up, and a generous per-artifact byte cap (well above what ~20 full-page PNGs need in practice).
const MAX_FALLBACK_SHOTS = 24;
const MAX_ARTIFACT_BYTES = 60 * 1024 * 1024;

function githubApiHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("accept", "application/vnd.github+json");
  headers.set("user-agent", "gittensory/0.1");
  headers.set("x-github-api-version", API_VERSION);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

/** List + download the named artifact from a completed workflow run, returning its extracted `.png` entries.
 *  Every step degrades to `[]` on failure (missing/expired artifact, oversized artifact, a download-redirect
 *  target outside isGithubArtifactStorageUrl, a network error, a malformed zip) -- callers treat an empty
 *  result exactly like "no fallback capture yet", never a crash. */
export async function fetchFallbackArtifactShots(params: {
  token: string;
  repo: GitHubRepo;
  runId: number;
  rateLimitAdmissionKey?: GitHubRateLimitAdmissionKey | undefined;
}): Promise<FallbackShot[]> {
  const base = `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}`;
  const repoLabel = `${params.repo.owner}/${params.repo.repo}`;
  try {
    const listResponse = await timeoutFetch(`${base}/actions/runs/${params.runId}/artifacts?per_page=100`, {
      headers: githubApiHeaders(params.token),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      githubRateLimitAdmission: params.rateLimitAdmissionKey !== undefined,
      ...(params.rateLimitAdmissionKey ? { githubRateLimitAdmissionKey: params.rateLimitAdmissionKey } : {}),
    });
    if (!listResponse.ok) return [];
    const listPayload = (await listResponse.json().catch(() => null)) as {
      artifacts?: Array<{ id: number; name: string; expired?: boolean; size_in_bytes?: number }>;
    } | null;
    const artifact = listPayload?.artifacts?.find((a) => a.name === FALLBACK_ARTIFACT_NAME && a.expired !== true);
    if (!artifact) return [];
    if (typeof artifact.size_in_bytes === "number" && artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
      console.log(JSON.stringify({ event: "visual_fallback_artifact_too_large", repo: repoLabel, runId: params.runId, bytes: artifact.size_in_bytes }));
      return [];
    }

    // Probe the download endpoint WITHOUT following its redirect -- the target is a short-lived, per-run
    // signed url on a different host, and its safety must be validated before this backend ever fetches it.
    const zipResponse = await fetch(`${base}/actions/artifacts/${artifact.id}/zip`, {
      headers: githubApiHeaders(params.token),
      redirect: "manual",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const location = zipResponse.headers.get("location");
    if (!location || !isGithubArtifactStorageUrl(location)) {
      console.log(JSON.stringify({ event: "visual_fallback_artifact_url_rejected", repo: repoLabel, runId: params.runId }));
      return [];
    }
    // Fetch the validated, presigned blob URL directly -- never forward the GitHub token to this third-party host.
    const blobResponse = await fetch(location, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    if (!blobResponse.ok) return [];
    const buffer = await blobResponse.arrayBuffer();
    if (buffer.byteLength > MAX_ARTIFACT_BYTES) return [];
    const entries = await parseZipEntries(new Uint8Array(buffer));

    const shots: FallbackShot[] = [];
    for (const entry of entries) {
      if (shots.length >= MAX_FALLBACK_SHOTS) break;
      if (!entry.name.toLowerCase().endsWith(".png")) continue;
      shots.push({ fileName: entry.name, png: entry.data });
    }
    return shots;
  } catch (error) {
    console.log(JSON.stringify({ event: "visual_fallback_artifact_fetch_error", repo: repoLabel, runId: params.runId, message: String(error).slice(0, 200) }));
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Route <-> artifact filename naming (must match the bash slugify in visual-capture-fallback.yml exactly).
// ---------------------------------------------------------------------------------------------------------

/** Slugify a route path into the filename-safe token the workflow uses for its screenshot names
 *  (`<slug>--desktop.png` / `<slug>--mobile.png`). "/" -> "root"; "/app/analytics" -> "app-analytics". Pure
 *  and deterministic so the workflow (bash) and this reader (TypeScript) independently compute the same
 *  name for the same route -- see the workflow file's own "Slugify routes" step, which implements the
 *  identical algorithm in bash. */
export function slugifyRoutePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "root";
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Build the expected artifact filename for one route + viewport -- the inverse of what the workflow writes,
 *  used by the caller to look up a specific route/viewport's shot in fetchFallbackArtifactShots' output. */
export function fallbackShotFileName(path: string, viewport: "desktop" | "mobile"): string {
  return `${slugifyRoutePath(path)}--${viewport}.png`;
}

// ---------------------------------------------------------------------------------------------------------
// R2 storage key -- shared between the workflow_run webhook handler (writer) and buildCapture (reader), so
// both independently derive the SAME key for the same (headSha, path, viewport) without a preview URL to
// fingerprint against (capturePage's own key scheme needs a real "page" url; a fallback shot has none).
// ---------------------------------------------------------------------------------------------------------

const FALLBACK_SHOT_NAMESPACE = "gittensory/shots/actions-fallback/";

/** The R2 key a fallback-captured shot is stored/read under for one PR head + route + viewport. Pure content
 *  address (no preview URL involved) -- deterministic so the write side (webhook handler) and the read side
 *  (buildCapture) always agree without any shared in-memory state. */
export async function fallbackShotR2Key(headSha: string, path: string, viewport: "desktop" | "mobile"): Promise<string> {
  const fingerprint = await sha256Hex(`${headSha}:actions-fallback:${viewport}:${path}`);
  return `${FALLBACK_SHOT_NAMESPACE}${fingerprint.slice(0, 40)}.png`;
}
