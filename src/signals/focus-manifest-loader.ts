import { listSignalSnapshots, persistSignalSnapshot } from "../db/repositories";
import type { JsonValue } from "../types";
import { nowIso } from "../utils/json";
import { parseFocusManifest, parseFocusManifestContent, type FocusManifest, type FocusManifestSource } from "./focus-manifest";

export const REPO_FOCUS_MANIFEST_SIGNAL = "repo-focus-manifest";
export const REPO_FOCUS_MANIFEST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Async source for the raw manifest text of a single repo. Returns null when no manifest is
 * published. Allows tests and the persisted-record path to swap out the public-GitHub fetcher.
 */
export type RepoFocusManifestFetcher = (repoFullName: string) => Promise<string | null>;

const MANIFEST_FILE_CANDIDATES = [".gittensory.json", ".github/gittensory.json"];

/**
 * Fetch a maintainer-owned manifest file from the public GitHub raw endpoint. Network or HTTP
 * failures resolve to null so the loader falls back to deterministic signals.
 */
export async function fetchRepoFocusManifestFile(repoFullName: string): Promise<string | null> {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return null;
  const owner = repoFullName.slice(0, slash);
  const name = repoFullName.slice(slash + 1);
  for (const path of MANIFEST_FILE_CANDIDATES) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/HEAD/${path}`;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "gittensory" } });
      if (response.ok) return await response.text();
    } catch {
      // try the next candidate path
    }
  }
  return null;
}

/**
 * Load the repo-owned focus manifest for a single repo. Reads a fresh persisted snapshot first
 * (the "API-backed repo settings record" path); on a miss or stale snapshot, fetches the
 * `.gittensory.json` file from the repo's default branch and caches the result. Missing or
 * malformed manifests degrade to a safe empty manifest with warnings rather than throwing.
 */
export async function loadRepoFocusManifest(
  env: Env,
  repoFullName: string,
  options: { fetcher?: RepoFocusManifestFetcher; maxAgeMs?: number; refresh?: boolean } = {},
): Promise<FocusManifest> {
  const fetcher = options.fetcher ?? fetchRepoFocusManifestFile;
  const maxAgeMs = options.maxAgeMs ?? REPO_FOCUS_MANIFEST_MAX_AGE_MS;
  if (!options.refresh) {
    const cached = await readCachedManifest(env, repoFullName, maxAgeMs);
    if (cached) return cached;
  }
  let manifest: FocusManifest;
  try {
    const content = await fetcher(repoFullName);
    manifest = content === null || content === undefined ? parseFocusManifest(null) : parseFocusManifestContent(content, "repo_file");
  } catch {
    manifest = parseFocusManifest(null);
  }
  if (manifest.present) {
    await persistRepoFocusManifest(env, repoFullName, manifest);
  }
  return manifest;
}

/** Bulk loader used by decision-pack and agent-planning paths to fetch many repos in parallel. */
export async function loadRepoFocusManifests(
  env: Env,
  repoFullNames: string[],
  options: { fetcher?: RepoFocusManifestFetcher; maxAgeMs?: number } = {},
): Promise<Map<string, FocusManifest>> {
  const entries = await Promise.all(
    repoFullNames.map(async (name) => [name.toLowerCase(), await loadRepoFocusManifest(env, name, options)] as const),
  );
  return new Map(entries);
}

/**
 * Persist a maintainer-supplied manifest (e.g. from a maintainer API/console) so subsequent
 * decision-pack and branch-analysis paths pick it up without refetching the repo file.
 */
export async function upsertRepoFocusManifest(env: Env, repoFullName: string, raw: unknown, source: FocusManifestSource = "api_record"): Promise<FocusManifest> {
  const manifest = parseFocusManifest(raw, source);
  await persistRepoFocusManifest(env, repoFullName, manifest);
  return manifest;
}

async function readCachedManifest(env: Env, repoFullName: string, maxAgeMs: number): Promise<FocusManifest | null> {
  const [latest] = await listSignalSnapshots(env, REPO_FOCUS_MANIFEST_SIGNAL, repoFullName);
  if (!latest) return null;
  const manifest = parseFocusManifest(latest.payload);
  const explicitSource =
    latest.payload !== null && typeof latest.payload === "object" && !Array.isArray(latest.payload)
      ? (latest.payload as Record<string, JsonValue>).source
      : undefined;
  if (explicitSource === "api_record") return manifest;
  if (snapshotAgeMs(latest.generatedAt) > maxAgeMs) return null;
  return manifest;
}

async function persistRepoFocusManifest(env: Env, repoFullName: string, manifest: FocusManifest): Promise<void> {
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType: REPO_FOCUS_MANIFEST_SIGNAL,
    targetKey: repoFullName,
    repoFullName,
    payload: manifestToJson(manifest),
    generatedAt: nowIso(),
  });
}

function manifestToJson(manifest: FocusManifest): Record<string, JsonValue> {
  return {
    source: manifest.source,
    wantedPaths: manifest.wantedPaths,
    blockedPaths: manifest.blockedPaths,
    preferredLabels: manifest.preferredLabels,
    linkedIssuePolicy: manifest.linkedIssuePolicy,
    testExpectations: manifest.testExpectations,
    issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
    maintainerNotes: manifest.maintainerNotes,
    publicNotes: manifest.publicNotes,
  };
}

function snapshotAgeMs(generatedAt: string | null | undefined): number {
  if (!generatedAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}
