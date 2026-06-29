// Container-private per-repo config (self-host). A self-host operator mounts a directory at
// GITTENSORY_REPO_CONFIG_DIR and configures each repo's review policy there; the focus-manifest loader reads it
// INSTEAD of fetching the public `.gittensory.yml`, so policy (gate, autonomy, labels, model/effort) is configured
// PRIVATELY and never exposed to contributors who could read and game the public file. Node-only — it is registered
// into the Workers-safe loader via setLocalManifestReader at boot (server.ts), so this module's fs import never
// reaches the Cloudflare bundle.
//
// Layout (CodeRabbit-style: per-repo override, then a global fallback). For a repo `JSONbored/gittensory` the
// reader tries, in priority order:
//   1. `jsonbored__gittensory/.gittensory.yml`  — owner-qualified folder (robust to repo-name collisions across owners)
//   2. `gittensory/.gittensory.yml`             — bare repo-name folder (the clean, human-readable layout)
//   3. `jsonbored__gittensory.yml`              — flat owner__repo file (the original #1390 layout; back-compat)
//   4. `.gittensory.yml`                        — GLOBAL fallback at the dir root: defaults applied to every repo
//      that has no per-repo file of its own.
// `.yaml` / `.json` are accepted everywhere `.yml` is. The first existing candidate wins outright (a present
// per-repo file fully REPLACES the global fallback — "fallback" means "used only when no per-repo file exists",
// not a deep merge). The slug is lowercased (GitHub repo full-names are case-insensitive; #1390 already lowercased).
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  RepoReviewContext,
  RepoReviewSkill,
} from "../signals/focus-manifest";
import type {
  RepoFocusManifestFetcher,
  RepoReviewContextReader,
} from "../signals/focus-manifest-loader";

/** The bare config filenames tried inside a per-repo folder and at the dir root (global fallback), in priority order. */
const CONFIG_BASENAMES = [".gittensory.yml", ".gittensory.yaml", ".gittensory.json"] as const;
const GITHUB_OWNER_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const GITHUB_REPO_SEGMENT = /^[a-z0-9._-]+$/;

function isSafeRepoSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && GITHUB_REPO_SEGMENT.test(segment);
}

/** Global-fallback candidates (relative to GITTENSORY_REPO_CONFIG_DIR): the dir-root `.gittensory.{yml,yaml,json}`
 *  applied to any repo without its own per-repo file. */
export const GLOBAL_CONFIG_CANDIDATES: string[] = [...CONFIG_BASENAMES];

/** Per-repo private-config candidate paths (relative to GITTENSORY_REPO_CONFIG_DIR), in priority order:
 *  owner-qualified folder → bare repo-name folder → flat `owner__repo` file (the #1390 back-compat form). The slug
 *  is the lowercased GitHub `owner__repo` (double underscore because `/` is not filename-safe); the bare folder is
 *  the lowercased repo name. An invalid repo full name (no single interior slash) yields no candidates. */
export function localConfigCandidates(repoFullName: string): string[] {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1 || slash !== repoFullName.lastIndexOf("/")) return [];
  const owner = repoFullName.slice(0, slash).toLowerCase();
  const repo = repoFullName.slice(slash + 1).toLowerCase();
  if (!GITHUB_OWNER_SEGMENT.test(owner) || !isSafeRepoSegment(repo)) return [];
  const slug = `${owner}__${repo}`;
  return [
    // 1. owner-qualified folder — `{owner}__{repo}/.gittensory.{yml,yaml,json}`
    ...CONFIG_BASENAMES.map((base) => join(slug, base)),
    // 2. bare repo-name folder — `{repo}/.gittensory.{yml,yaml,json}`
    ...CONFIG_BASENAMES.map((base) => join(repo, base)),
    // 3. flat owner__repo file (#1390) — `{owner}__{repo}.{yml,yaml,json}`
    ...CONFIG_BASENAMES.map((base) => `${slug}${base.slice(".gittensory".length)}`),
  ];
}

/** Build the container-local manifest reader over GITTENSORY_REPO_CONFIG_DIR, or null when the dir is unset/blank
 *  (⇒ the loader keeps fetching the public `.gittensory.yml`). Each lookup returns the first existing per-repo
 *  candidate's text; failing that, the global-fallback `.gittensory.{yml,yaml,json}` at the dir root; null when
 *  neither exists (⇒ the loader falls through to the public file). An invalid repo full name yields no per-repo
 *  candidates and is NOT served the global fallback (it is never a real webhook repo). A read error on one
 *  candidate is swallowed so the next candidate is tried. */
export function makeLocalManifestReader(dir: string | undefined): RepoFocusManifestFetcher | null {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return null;
  const base = resolve(trimmed);
  return async (repoFullName: string): Promise<string | null> => {
    const perRepo = localConfigCandidates(repoFullName);
    if (perRepo.length === 0) return null; // invalid repo name → no per-repo file AND no global fallback
    for (const candidate of [...perRepo, ...GLOBAL_CONFIG_CANDIDATES]) {
      try {
        return await readFile(resolve(base, candidate), "utf8");
      } catch {
        // ENOENT / unreadable → try the next candidate
      }
    }
    return null;
  };
}

/** Per-repo review-context candidate FOLDERS (relative to GITTENSORY_REPO_CONFIG_DIR): `{owner}__{repo}/review` then
 *  `{repo}/review`. Same owner/repo validation as localConfigCandidates; an invalid full name yields none. (#review-skills) */
function reviewContextFolders(repoFullName: string): string[] {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1 || slash !== repoFullName.lastIndexOf("/")) return [];
  const owner = repoFullName.slice(0, slash).toLowerCase();
  const repo = repoFullName.slice(slash + 1).toLowerCase();
  if (!GITHUB_OWNER_SEGMENT.test(owner) || !isSafeRepoSegment(repo)) return [];
  return [join(`${owner}__${repo}`, "review"), join(repo, "review")];
}

/** Parse a skill markdown file into {name, when, body}. YAML frontmatter (`---\nname:\nwhen:\n---`) is optional; name
 *  defaults to the filename and `when` to "always". */
export function parseReviewSkill(filename: string, text: string): RepoReviewSkill {
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  const head = fm?.[1] ?? "";
  const body = (fm?.[2] ?? text).trim();
  const name = /(?:^|\n)name:\s*(.+)/.exec(head)?.[1]?.trim() || filename.replace(/\.md$/i, "");
  const whenRaw = /(?:^|\n)when:\s*(.+)/.exec(head)?.[1]?.trim();
  const when = (whenRaw ?? "always").replace(/^["']|["']$/g, "") || "always";
  return { name, when, body };
}

/** Build the container-local review-context reader over GITTENSORY_REPO_CONFIG_DIR, or null when the dir is unset. Per
 *  repo (first existing folder wins) reads `review/AGENTS.md` (Codex) or `review/CLAUDE.md` (Claude Code) as the
 *  guide + every `review/skills/*.md` rubric module, sorted. Missing files/dir degrade to nulls/empty; a per-file
 *  read error skips that file. (#review-skills) */
export function makeLocalReviewContextReader(dir: string | undefined): RepoReviewContextReader | null {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return null;
  const base = resolve(trimmed);
  return async (repoFullName: string): Promise<RepoReviewContext> => {
    for (const folder of reviewContextFolders(repoFullName)) {
      const abs = resolve(base, folder);
      let guide: string | null = null;
      for (const guideName of ["AGENTS.md", "CLAUDE.md"]) {
        try {
          guide = await readFile(resolve(abs, guideName), "utf8");
          break;
        } catch {
          // no per-repo guide at this candidate name
        }
      }
      const skills: RepoReviewSkill[] = [];
      try {
        const entries = (await readdir(resolve(abs, "skills"))).filter((f) => f.toLowerCase().endsWith(".md")).sort();
        for (const f of entries) {
          try {
            skills.push(parseReviewSkill(f, await readFile(resolve(abs, "skills", f), "utf8")));
          } catch {
            // unreadable skill file → skip it
          }
        }
      } catch {
        // no skills/ dir
      }
      if (guide !== null || skills.length > 0) return { guide, skills };
    }
    return { guide: null, skills: [] };
  };
}
