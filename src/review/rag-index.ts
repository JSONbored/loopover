// Convergence (RAG / codebase index — Layer C, flag GITTENSORY_REVIEW_RAG): the INDEX-POPULATION driver. This is
// the population half (rag-wire.ts wires RETRIEVAL only):
// it fetches a repo's CODE tree, chunks + embeds it, and upserts vectors+text into the `gittensory-review-rag`
// Vectorize index + the `repo_chunks` table (migration 0051) — so retrieval has a warm index to read from instead
// of always seeing a cold namespace and returning "".
//
// It reuses the fail-safe primitives in `./rag` verbatim (chunkFile / embedTexts / upsertChunks /
// deleteChunksForPaths / countRepoChunks / isIndexablePath / MAX_CHUNKS_PER_REPO / ragNamespace) — NO chunking or
// embedding logic is reimplemented here. The only new I/O is fetching the repo's git tree + file contents, which
// reuses the installation-token + raw-Contents-API pattern grounding-wire already established
// (`makeGithubFileFetcher`); the tree fetch is the one new GitHub call.
//
// HARD GUARANTEES (mirroring rag.ts):
//   1. FAIL-SAFE — every step is caught + logged; this module NEVER throws into the queue/caller. A missing
//      Vectorize/AI binding, a GitHub error, an oversized repo, or a partial batch degrades to "indexed less /
//      nothing" rather than failing the job. `upsertChunks` itself already no-ops to 0 when infra is absent.
//   2. FREE-TIER — `isIndexablePath` filters the tree to CODE (not the content/data corpus), source is
//      prioritized ahead of docs, manifest/config files (package.json, tsconfig*.json, wrangler.*,
//      pnpm-workspace.yaml, go.mod, Cargo.toml, pyproject.toml, ...) are prioritized ahead of THAT
//      (manifestPriority — on a repo over the cap they'd otherwise tie every other source file and lose
//      the alphabetical tiebreaker), and a hard MAX_CHUNKS_PER_REPO cap bounds stored vectors per repo
//      (the same cap retrieval assumes). We stop fetching once the cap is reached.
//
// GATING — the caller (processors.ts) only DISPATCHES indexing when `isRagEnabled(env)` is true, and the cron
// only ENQUEUES the fan-out under the same flag; flag-OFF (the default) this module is never invoked, makes no
// GitHub call, and does no adapter use — the deploy is byte-identical to today.

import { createInstallationToken } from "../github/app";
import { githubRateLimitAdmissionKeyForInstallation, timeoutFetch, type GitHubRateLimitAdmissionKey } from "../github/client";
import { isConfigFile, isDependencyManifestFile } from "../signals/path-matchers";
import { repoParts } from "../utils/json";
import { createReviewAdapters } from "./adapters";
import {
  chunkFile,
  countRepoChunks,
  deleteChunksForPaths,
  filePriority,
  isIndexablePath,
  MAX_CHUNKS_PER_REPO,
  MAX_FILE_BYTES,
  ragNamespace,
  type RagChunk,
  upsertChunks,
} from "./rag";

/** A single indexable entry from the repo git tree (path + size, used by isIndexablePath's size guard). */
type TreeEntry = { path: string; size?: number | undefined };

/**
 * Sort key that puts small, high-value manifest/config files (package.json, tsconfig*.json,
 * wrangler.jsonc, pnpm-workspace.yaml, go.mod, Cargo.toml, pyproject.toml, requirements*.txt, ...)
 * AHEAD of filePriority's code/doc split. On a repo whose file count exceeds MAX_CHUNKS_PER_REPO,
 * `indexRepo`'s per-file loop stops once the cap is hit — with only `filePriority` (code=0, doc=1)
 * as the sort key, a manifest file ties every other source file at priority 0 and then loses on the
 * alphabetical tiebreaker, so it can be starved out entirely by volume (verified in prod: gittensory's
 * own package.json never got indexed). These files are already indexable code (JSON/TOML/YAML all
 * match CODE_EXT_RE in `./rag`) — this only reorders them, it does not change what's included.
 * Reuses the same "manifest-like filename" classifiers signals/path-matchers.ts already exports for
 * slop classification (isDependencyManifestFile / isConfigFile) rather than inventing a second
 * filename vocabulary.
 */
function manifestPriority(path: string): number {
  return isDependencyManifestFile(path) || isConfigFile(path) ? -1 : filePriority(path);
}

/** Cap on how many chunks we upsert per Vectorize/D1 write batch (bounds the bound-param + neuron cost per call;
 *  embedTexts itself batches the AI calls at EMBED_BATCH internally). */
const UPSERT_BATCH = 50;

/** Abort a GitHub read that hangs — a stalled connection on the tree/contents fetch would otherwise pin the whole
 *  index job (and the queue consumer running it) indefinitely. Aborts land in the existing fail-safe catches. */
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

/** Resolve the read token once for a repo: installation token (private-repo read) → public token → none.
 *  Best-effort — a token failure degrades to the next fallback, never throws. (Mirrors makeGithubFileFetcher.) */
async function resolveReadToken(env: Env, installationId: number | null | undefined): Promise<{ token: string | undefined; admissionKey?: GitHubRateLimitAdmissionKey | undefined }> {
  if (installationId) {
    const token = await createInstallationToken(env, installationId).catch(() => undefined);
    if (token) return { token, admissionKey: githubRateLimitAdmissionKeyForInstallation(installationId) };
  }
  return { token: env.GITHUB_PUBLIC_TOKEN };
}

/** Shared GitHub headers for the read calls (raw media type returns file bodies directly). */
function ghHeaders(token: string | undefined, accept: string): Record<string, string> {
  return {
    accept,
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Fetch the FULL recursive git tree for a repo at `ref` and return only the blob (file) entries. Uses the
 * Git Trees API (`?recursive=1`) — one call yields the whole tree. Returns [] on any non-OK / error response
 * (fail-safe: a tree we can't read = nothing to index). `truncated` is honored (GitHub truncates very large
 * trees) — we index whatever it returned; the MAX_CHUNKS cap is the real bound anyway.
 */
async function fetchRepoTree(env: Env, repoFullName: string, ref: string, token: string | undefined, admissionKey: GitHubRateLimitAdmissionKey | undefined): Promise<TreeEntry[] | null> {
  try {
    const { owner, name } = repoParts(repoFullName);
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const response = await timeoutFetch(url, {
      headers: ghHeaders(token, "application/vnd.github+json"),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      githubRateLimitAdmission: admissionKey !== undefined,
      ...(admissionKey ? { githubRateLimitAdmissionKey: admissionKey } : {}),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tree?: Array<{ path?: string; type?: string; size?: number }> } | null;
    const entries: TreeEntry[] = [];
    for (const node of body?.tree ?? []) {
      if (node.type !== "blob" || typeof node.path !== "string" || node.path.length === 0) continue;
      entries.push(typeof node.size === "number" ? { path: node.path, size: node.size } : { path: node.path });
    }
    return entries;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "rag_index_tree_error", ev: "rag_index_tree_error", repo: repoFullName, message: String(error).slice(0, 200) }));
    return null;
  }
}

/** Read a response body as UTF-8 text, aborting once the byte limit is exceeded. */
async function readTextCapped(response: Response, maxBytes: number): Promise<string | null> {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > maxBytes ? null : new TextDecoder().decode(buffer);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** Fetch a single file's raw text at `ref`. null on any non-OK / oversized / error (fail-safe — skip that file). */
async function fetchFileText(
  env: Env,
  repoFullName: string,
  path: string,
  ref: string,
  token: string | undefined,
  admissionKey: GitHubRateLimitAdmissionKey | undefined,
  maxBytes = MAX_FILE_BYTES,
): Promise<string | null> {
  try {
    const { owner, name } = repoParts(repoFullName);
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(ref)}`;
    const response = await timeoutFetch(url, {
      headers: ghHeaders(token, "application/vnd.github.raw+json"),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      githubRateLimitAdmission: admissionKey !== undefined,
      ...(admissionKey ? { githubRateLimitAdmissionKey: admissionKey } : {}),
    });
    if (!response.ok) return null;
    return await readTextCapped(response, maxBytes);
  } catch {
    return null;
  }
}

/** Resolve the ref to index a repo at: the repo's default branch, falling back to HEAD when unknown. */
function indexRef(defaultBranch: string | null | undefined): string {
  const branch = (defaultBranch ?? "").trim();
  return branch.length > 0 ? branch : "HEAD";
}

/** Upsert a set of chunks to the index in bounded batches, honoring the per-repo cap. Returns the number
 *  actually upserted. Each batch is independent: a failed batch (upsertChunks returns 0) doesn't abort the rest. */
async function upsertChunksCapped(env: Env, project: string, repo: string, chunks: RagChunk[], alreadyStored: number): Promise<number> {
  const infra = createReviewAdapters(env);
  let stored = alreadyStored;
  let upserted = 0;
  for (let i = 0; i < chunks.length && stored < MAX_CHUNKS_PER_REPO; i += UPSERT_BATCH) {
    const remaining = MAX_CHUNKS_PER_REPO - stored;
    const batch = chunks.slice(i, i + Math.min(UPSERT_BATCH, remaining));
    if (batch.length === 0) break;
    const n = await upsertChunks(infra, project, repo, batch);
    upserted += n;
    stored += n;
  }
  return upserted;
}


/** Return distinct paths currently retained for a repo in the chunk text store. Fail-safe: [] on error.
 *  Exported for repo-profile.ts (#2999): the architecture/module-map extraction reuses this exact query
 *  instead of re-deriving its own "what files does this repo have indexed" logic. */
export async function listStoredChunkPaths(infra: ReturnType<typeof createReviewAdapters>, project: string, repo: string): Promise<string[]> {
  try {
    const rows = await infra.storage
      .prepare("SELECT DISTINCT path FROM repo_chunks WHERE project=? AND repo=?")
      .bind(project, repo)
      .all<{ path: string }>();
    return (rows.results ?? []).map((row) => row.path).filter((path) => typeof path === "string" && path.length > 0);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "rag_list_paths_error", ev: "rag_list_paths_error", project, repo, message: String(error).slice(0, 200) }));
    return [];
  }
}

/**
 * Prune chunks for paths that are no longer indexable in the current default-branch tree. This is the full-index
 * counterpart to reindexChangedPaths' delete-first behavior and prevents deleted/renamed files from being retained
 * indefinitely in repo_chunks/Vectorize.
 */
async function pruneMissingPaths(
  infra: ReturnType<typeof createReviewAdapters>,
  project: string,
  repo: string,
  currentIndexablePaths: Set<string>,
): Promise<void> {
  const storedPaths = await listStoredChunkPaths(infra, project, repo);
  const stalePaths = storedPaths.filter((path) => !currentIndexablePaths.has(path));
  if (stalePaths.length === 0) return;
  await deleteChunksForPaths(infra, project, repo, stalePaths);
}

/** Split `owner/name` into the (project, repo) pair RAG namespaces on (same convention as rag-wire's splitRepo). */
function splitRepo(repoFullName: string): [string, string] {
  const slash = repoFullName.indexOf("/");
  return slash === -1 ? ["", repoFullName] : [repoFullName.slice(0, slash), repoFullName.slice(slash + 1)];
}

export type IndexRepoResult = { indexed: number; files: number; capped: boolean };

/**
 * FULL (re)index of a repo's CODE into the RAG index. Fetches the git tree at the default branch, filters to
 * indexable code/docs (isIndexablePath), prioritizes manifest/config files first, then source over docs
 * (manifestPriority), fetches each file's content, chunks it (chunkFile), and upserts (embed + Vectorize +
 * repo_chunks via upsertChunks) up to MAX_CHUNKS_PER_REPO.
 *
 * Idempotent: chunk ids are stable (namespace|path::idx) so re-running upserts (ON CONFLICT updates) the same
 * rows rather than duplicating. Fully FAIL-SAFE — any error (no infra, GitHub down, bad file) degrades to
 * "indexed fewer / nothing"; this NEVER throws.
 *
 * @param repo the RepositoryRecord (fullName + installationId + defaultBranch). installationId/defaultBranch are
 *             read off it so the caller doesn't re-fetch.
 */
export async function indexRepo(
  env: Env,
  project: string,
  repo: { fullName: string; installationId?: number | null | undefined; defaultBranch?: string | null | undefined },
): Promise<IndexRepoResult> {
  const empty: IndexRepoResult = { indexed: 0, files: 0, capped: false };
  try {
    const infra = createReviewAdapters(env);
    // No vector index or no AI binding → upsert is a guaranteed no-op; don't spend any GitHub calls.
    if (!infra.vector || !infra.inference) return empty;
    const repoFullName = repo.fullName;
    const [, repoName] = splitRepo(repoFullName);
    const namespace = ragNamespace(project, repoName);
    const { token, admissionKey } = await resolveReadToken(env, repo.installationId);
    const ref = indexRef(repo.defaultBranch);

    // 1. Fetch the tree, filter to indexable code/docs, and prune retained chunks for files that disappeared
    //    or moved to a non-indexable path. If the tree fetch fails (null), skip pruning to avoid deleting good
    //    chunks during a transient GitHub/API failure.
    const rawTree = await fetchRepoTree(env, repoFullName, ref, token, admissionKey);
    if (rawTree === null) return empty;
    const tree = rawTree
      .filter((entry) => isIndexablePath(entry.path, entry.size))
      .sort((a, b) => manifestPriority(a.path) - manifestPriority(b.path) || a.path.localeCompare(b.path));
    await pruneMissingPaths(infra, project, repoName, new Set(tree.map((entry) => entry.path)));
    if (tree.length === 0) return empty;

    // 2. Fetch + chunk + upsert, stopping once the per-repo vector cap is reached.
    let stored = 0;
    let upserted = 0;
    let filesIndexed = 0;
    let capped = false;
    for (const entry of tree) {
      if (stored >= MAX_CHUNKS_PER_REPO) {
        capped = true;
        break;
      }
      const text = await fetchFileText(env, repoFullName, entry.path, ref, token, admissionKey);
      if (text === null) continue;
      const chunks = chunkFile(entry.path, text, namespace);
      if (chunks.length === 0) continue;
      const n = await upsertChunksCapped(env, project, repoName, chunks, stored);
      if (n > 0) {
        upserted += n;
        stored += n;
        filesIndexed += 1;
      }
    }
    console.log(
      JSON.stringify({ ev: "rag_index_repo", project, repo: repoFullName, files: filesIndexed, indexed: upserted, capped }),
    );
    return { indexed: upserted, files: filesIndexed, capped };
  } catch (error) {
    console.log(JSON.stringify({ ev: "rag_index_repo_error", repo: repo.fullName, message: String(error).slice(0, 200) }));
    return empty;
  }
}

/**
 * INCREMENTAL re-index of only the CHANGED paths of a repo (push / PR-merge maintenance). For the given paths:
 * deletes their existing chunks (deleteChunksForPaths — removes both stale vectors + text), then re-fetches +
 * re-chunks + re-upserts the indexable ones at the default branch. A path that's no longer indexable (deleted
 * file, or now a content/data path) is simply deleted and not re-added. Fully FAIL-SAFE — NEVER throws.
 *
 * @param paths the changed file paths (e.g. from a push or merged-PR file list).
 */
export async function reindexChangedPaths(
  env: Env,
  project: string,
  repo: { fullName: string; installationId?: number | null | undefined; defaultBranch?: string | null | undefined },
  paths: string[],
): Promise<IndexRepoResult> {
  const empty: IndexRepoResult = { indexed: 0, files: 0, capped: false };
  try {
    const unique = [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0))];
    if (unique.length === 0) return empty;
    const infra = createReviewAdapters(env);
    if (!infra.vector || !infra.inference) return empty;
    const repoFullName = repo.fullName;
    const [, repoName] = splitRepo(repoFullName);
    const namespace = ragNamespace(project, repoName);

    // 1. Drop the existing chunks for EVERY changed path (deleted/renamed/no-longer-indexable files leave nothing
    //    stale behind). deleteChunksForPaths is fail-safe + batches the IN-lists internally.
    await deleteChunksForPaths(infra, project, repoName, unique);

    // 2. Re-index the ones that are still indexable code/docs at the default branch.
    const indexable = unique.filter((path) => isIndexablePath(path));
    if (indexable.length === 0) return { indexed: 0, files: 0, capped: false };
    const { token, admissionKey } = await resolveReadToken(env, repo.installationId);
    const ref = indexRef(repo.defaultBranch);
    let stored = await countRepoChunks(infra.storage, project, repoName);
    let upserted = 0;
    let filesIndexed = 0;
    let capped = false;
    for (const path of indexable) {
      if (stored >= MAX_CHUNKS_PER_REPO) {
        capped = true;
        break;
      }
      const text = await fetchFileText(env, repoFullName, path, ref, token, admissionKey);
      if (text === null) continue; // file deleted at head, oversized, or unreadable — already removed above, leave it gone
      const chunks = chunkFile(path, text, namespace);
      if (chunks.length === 0) continue;
      const n = await upsertChunksCapped(env, project, repoName, chunks, stored);
      if (n > 0) {
        upserted += n;
        stored += n;
        filesIndexed += 1;
      }
    }
    console.log(
      JSON.stringify({ ev: "rag_reindex_paths", project, repo: repoFullName, paths: unique.length, files: filesIndexed, indexed: upserted, capped }),
    );
    return { indexed: upserted, files: filesIndexed, capped };
  } catch (error) {
    console.log(JSON.stringify({ ev: "rag_reindex_paths_error", repo: repo.fullName, message: String(error).slice(0, 200) }));
    return empty;
  }
}
