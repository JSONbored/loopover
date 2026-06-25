// Container-private per-repo config (self-host). A self-host operator mounts a directory at
// GITTENSORY_REPO_CONFIG_DIR and drops one `{owner}__{repo}.yml` file per repo; the focus-manifest loader reads
// it INSTEAD of fetching the public `.gittensory.yml`, so review policy (gate, autonomy, labels, model/effort) is
// configured PRIVATELY and never exposed to contributors who could read and game the public file. Node-only — it
// is registered into the Workers-safe loader via setLocalManifestReader at boot (server.ts), so this module's fs
// import never reaches the Cloudflare bundle.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoFocusManifestFetcher } from "../signals/focus-manifest-loader";

/** Candidate filenames for a repo's private config, in priority order. The slug is the lowercased GitHub
 *  `owner__repo` (double underscore because `/` is not filename-safe) — e.g. `JSONbored/metagraphed` →
 *  `jsonbored__metagraphed.yml`. An invalid repo full name (no single interior slash) yields no candidates. */
export function localConfigCandidates(repoFullName: string): string[] {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return [];
  const slug = `${repoFullName.slice(0, slash)}__${repoFullName.slice(slash + 1)}`.toLowerCase();
  return [`${slug}.yml`, `${slug}.yaml`, `${slug}.json`];
}

/** Build the container-local manifest reader over GITTENSORY_REPO_CONFIG_DIR, or null when the dir is unset/blank
 *  (⇒ the loader keeps fetching the public `.gittensory.yml`). Each lookup returns the first existing
 *  `{dir}/{owner}__{repo}.{yml,yaml,json}` file's text; null when none exist for the repo (⇒ the loader falls
 *  through to the public file). A read error on one candidate is swallowed so the next candidate is tried. */
export function makeLocalManifestReader(dir: string | undefined): RepoFocusManifestFetcher | null {
  const base = (dir ?? "").trim();
  if (!base) return null;
  return async (repoFullName: string): Promise<string | null> => {
    for (const candidate of localConfigCandidates(repoFullName)) {
      try {
        return await readFile(join(base, candidate), "utf8");
      } catch {
        // ENOENT / unreadable → try the next candidate
      }
    }
    return null;
  };
}
