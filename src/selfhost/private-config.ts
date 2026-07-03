// Container-private per-repo config (self-host). A self-host operator mounts a directory at
// GITTENSORY_REPO_CONFIG_DIR and configures each repo's review policy there; the focus-manifest loader reads it
// INSTEAD of fetching the public `.gittensory.yml`, so policy (gate, autonomy, labels, model/effort) is configured
// PRIVATELY and never exposed to contributors who could read and game the public file. Node-only — it is registered
// into the Workers-safe loader via setLocalManifestReader at boot (server.ts), so this module's fs import never
// reaches the Cloudflare bundle.
//
// Layout (CodeRabbit-style: per-repo override, layered over a global default). For a repo `JSONbored/gittensory`
// the reader tries, in priority order:
//   1. `jsonbored__gittensory/.gittensory.yml`  — owner-qualified folder (robust to repo-name collisions across owners)
//   2. `gittensory/.gittensory.yml`             — bare repo-name folder (the clean, human-readable layout)
//   3. `jsonbored__gittensory.yml`              — flat owner__repo file (the original #1390 layout; back-compat)
//   4. `.gittensory.yml`                        — GLOBAL default at the dir root, shared by every repo.
// `.yaml` / `.json` are accepted everywhere `.yml` is. With only ONE of {a per-repo candidate, the global default}
// present, its raw text is returned unchanged — byte-identical to the original #1390 behavior. With BOTH present,
// they are DEEP-MERGED (the per-repo file overlaid onto the global default): nested mappings (`gate`, `settings`,
// `review`, `features`, `contentLane`, and their own nested blocks) merge key by key, arrays replace wholesale
// (never concatenated), and an explicit YAML/JSON `null` at a key always overrides the global value there — which
// clears a setting wherever the manifest parser already treats an explicit null as "off"/"clear" (e.g.
// `settings.contributorOpenPrCap`, `settings.accountAgeThresholdDays`), and is otherwise equivalent to omitting the
// key. A per-repo key that is simply absent leaves the corresponding global value untouched. If ONE file fails to
// parse as a YAML/JSON mapping (or is oversized), the merge is skipped and the OTHER file's raw text is used alone
// — a still-valid sibling's policy is never silently discarded just because its counterpart is broken. If BOTH
// fail, the per-repo file's raw text is returned (matching the original single-candidate priority), so a doubly
// broken pair degrades exactly like a single malformed manifest always has. The slug is lowercased (GitHub repo
// full-names are case-insensitive; #1390 already lowercased).
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MAX_FOCUS_MANIFEST_BYTES } from "../signals/focus-manifest";
import type {
  RepoReviewContext,
  RepoReviewSkill,
} from "../signals/focus-manifest";
import type {
  RepoFocusManifestFetcher,
  RepoReviewContextReader,
} from "../signals/focus-manifest-loader";

/** The bare config filenames tried inside a per-repo folder and at the dir root (global default), in priority order. */
const CONFIG_BASENAMES = [".gittensory.yml", ".gittensory.yaml", ".gittensory.json"] as const;
const GITHUB_OWNER_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const GITHUB_REPO_SEGMENT = /^[a-z0-9._-]+$/;

function isSafeRepoSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && GITHUB_REPO_SEGMENT.test(segment);
}

/** Global-default candidates (relative to GITTENSORY_REPO_CONFIG_DIR): the dir-root `.gittensory.{yml,yaml,json}`,
 *  deep-merged under any per-repo file (or applied alone, when a repo has no per-repo file of its own). */
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

/** Read the first candidate that exists, trying each in order; null when none do. A read error (ENOENT or
 *  otherwise unreadable) is swallowed so the next candidate is tried. */
async function readFirstExisting(base: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      return await readFile(resolve(base, candidate), "utf8");
    } catch {
      // ENOENT / unreadable → try the next candidate
    }
  }
  return null;
}

/** Tolerantly parse raw config text into a plain mapping for MERGE PURPOSES ONLY — same 2-line YAML/JSON detection
 *  `parseFocusManifestContent` (focus-manifest.ts) uses, duplicated locally rather than exported from there so that
 *  file's public surface stays unchanged for what is otherwise two lines of logic. Returns null — "not mergeable" —
 *  for empty/oversized text, a parse error, or a parsed value that isn't a plain mapping (null/array/scalar); every
 *  one of those cases makes the caller fall back to legacy single-candidate behavior instead of attempting a merge. */
function parseConfigMapping(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_FOCUS_MANIFEST_BYTES) return null;
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksLikeJson ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** Recursively overlay `override` onto `base`: a nested mapping merges key by key; an array or any other
 *  non-mapping override value (including an explicit `null`) REPLACES the base value at that key wholesale — never
 *  concatenated or blended. A key `override` never mentions leaves `base`'s value at that key completely untouched.
 *  Exported for direct unit testing; deliberately ignorant of any manifest field name (`gate`, `settings`,
 *  `wantedPaths`, etc.) so it composes correctly with the whole `.gittensory.yml` schema, present and future, with
 *  zero repo- or field-specific code. */
export function mergeConfigOverlay(base: unknown, override: unknown): unknown {
  if (override === null) return null;
  if (Array.isArray(override)) return override;
  if (typeof override !== "object") return override;
  if (base === null || typeof base !== "object" || Array.isArray(base)) return override;
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    merged[key] = mergeConfigOverlay((base as Record<string, unknown>)[key], (override as Record<string, unknown>)[key]);
  }
  return merged;
}

/** Combine a global-default and a per-repo config's raw text, given that BOTH files exist. Both parse as mappings
 *  → deep-merged (the per-repo file overlaid onto the global default via {@link mergeConfigOverlay}) into one JSON
 *  document — a lossless round trip for the downstream `parseFocusManifestContent` (it starts with `{`, so that
 *  parser `JSON.parse`s it) since both inputs are already JSON-safe values. Only one parses → that file's raw text
 *  alone (best-effort: a broken sibling never discards a still-valid file's policy). Neither parses → the per-repo
 *  text (matching the original single-candidate-wins priority, so it flows downstream to the same "malformed,
 *  ignoring" warning a lone broken manifest always got). */
function combineConfigText(globalText: string, repoText: string): string {
  const globalRaw = parseConfigMapping(globalText);
  const repoRaw = parseConfigMapping(repoText);
  if (globalRaw && repoRaw) return JSON.stringify(mergeConfigOverlay(globalRaw, repoRaw));
  if (repoRaw) return repoText;
  if (globalRaw) return globalText;
  return repoText;
}

/** Build the container-local manifest reader over GITTENSORY_REPO_CONFIG_DIR, or null when the dir is unset/blank
 *  (⇒ the loader keeps fetching the public `.gittensory.yml`). Looks up the first existing per-repo candidate and
 *  the global-default candidate independently: with only one present, its raw text is returned unchanged; with
 *  both present, they are deep-merged (see the module header) and returned as one JSON document; with neither
 *  present, null (⇒ the loader falls through to the public file). An invalid repo full name yields no per-repo
 *  candidates and is NOT served the global default (it is never a real webhook repo). */
export function makeLocalManifestReader(dir: string | undefined): RepoFocusManifestFetcher | null {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return null;
  const base = resolve(trimmed);
  return async (repoFullName: string): Promise<string | null> => {
    const perRepo = localConfigCandidates(repoFullName);
    if (perRepo.length === 0) return null; // invalid repo name → no per-repo file AND no global default
    const [repoText, globalText] = await Promise.all([readFirstExisting(base, perRepo), readFirstExisting(base, GLOBAL_CONFIG_CANDIDATES)]);
    if (repoText === null) return globalText;
    if (globalText === null) return repoText;
    return combineConfigText(globalText, repoText);
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

/** Read a `name:` / `when:` frontmatter value robustly. The value text (everything after the key on its line) is
 *  parsed as a standalone YAML scalar, so the real parser handles quoting, escaped `\"` / doubled `''` quotes, and a
 *  trailing inline comment — `"SQL #1 Rubric"` keeps its internal `#`, `SQL Rubric  # note` drops the comment. A
 *  value the YAML parser rejects standalone — notably an unquoted glob that begins with a `*` wildcard — falls back
 *  to a lenient strip (drop an inline comment and any surrounding quote) so those globs keep working. */
function reviewSkillScalar(rawValue: string): string {
  try {
    const parsed = parseYaml(rawValue);
    if (typeof parsed === "string") return parsed.trim();
  } catch {
    // not a standalone-parseable scalar (e.g. an unquoted *-leading glob) — fall through to the lenient strip
  }
  return rawValue.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
}

/** Parse a skill markdown file into {name, when, body}. YAML frontmatter (`---\nname:\nwhen:\n---`) is optional; name
 *  defaults to the filename and `when` to "always". `name`/`when` are decoded through the YAML parser (see
 *  reviewSkillScalar) so a quoted value keeps its contents (incl. an internal `#`) while a trailing inline comment is
 *  dropped — an unstripped comment corrupts the label and turns `when` into a glob that never matches, silently
 *  disabling the rubric. */
export function parseReviewSkill(filename: string, text: string): RepoReviewSkill {
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  const head = fm?.[1] ?? "";
  const body = (fm?.[2] ?? text).trim();
  const nameRaw = /(?:^|\n)name:\s*(.+)/.exec(head)?.[1];
  const name = (nameRaw !== undefined ? reviewSkillScalar(nameRaw) : "") || filename.replace(/\.md$/i, "");
  const whenRaw = /(?:^|\n)when:\s*(.+)/.exec(head)?.[1];
  const when = (whenRaw !== undefined ? reviewSkillScalar(whenRaw) : "always") || "always";
  return { name, when, body };
}

/** True unless a skill's frontmatter explicitly disables it with `enabled: false` (or `no`/`off`/`0`). Absent or
 *  truthy `enabled` keeps the skill, so existing skills are unaffected — this only lets an operator turn a rubric
 *  OFF without deleting the file. Truthy vocabulary matches the codebase flag convention. (#review-skills) */
export function isReviewSkillEnabled(text: string): boolean {
  const head = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text)?.[1] ?? "";
  // Drop a YAML inline comment (` # …`) before matching, so `enabled: true  # explicit` reads as `true`, not
  // `true # explicit` (which would fail the truthy test and wrongly disable the skill).
  const raw = /(?:^|\n)enabled:\s*(.+)/.exec(head)?.[1]?.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  return raw === undefined ? true : /^(1|true|yes|on)$/i.test(raw);
}

/** Build the container-local review-context reader over GITTENSORY_REPO_CONFIG_DIR, or null when the dir is unset. Per
 *  repo (first existing folder wins) reads `review/AGENTS.md` (Codex) or `review/CLAUDE.md` (Claude Code) as the
 *  guide + every `review/skills/*.md` rubric module, sorted. A skill whose frontmatter sets `enabled: false` is
 *  omitted (turned off without deleting the file). Missing files/dir degrade to nulls/empty; a per-file read
 *  error skips that file. (#review-skills) */
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
            const text = await readFile(resolve(abs, "skills", f), "utf8");
            if (!isReviewSkillEnabled(text)) continue; // `enabled: false` frontmatter disables a skill without deleting it
            skills.push(parseReviewSkill(f, text));
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
