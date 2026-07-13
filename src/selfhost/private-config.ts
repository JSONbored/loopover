// Container-private per-repo config (self-host). A self-host operator mounts a directory at
// LOOPOVER_REPO_CONFIG_DIR and configures each repo's review policy there; the focus-manifest loader reads it
// INSTEAD of fetching the public `.loopover.yml`, so policy (gate, autonomy, labels, model/effort) is configured
// PRIVATELY and never exposed to contributors who could read and game the public file. Node-only — it is
// registered into the Workers-safe loader via setLocalManifestReader at boot (server.ts), so this module's fs
// import never reaches the Cloudflare bundle.
//
// Layout (CodeRabbit-style: per-repo override, layered over a global default, layered over a cross-repo shared
// base — #1959). For a repo `JSONbored/gittensory` the reader tries, in priority order:
//   1. `jsonbored__gittensory/.loopover.yml`    — owner-qualified folder (robust to repo-name collisions across owners)
//   2. `gittensory/.loopover.yml`               — bare repo-name folder (the clean, human-readable layout)
//   3. `jsonbored__gittensory.yml`              — flat owner__repo file (the original #1390 layout; back-compat)
//   4. `.loopover.yml`                          — GLOBAL default at the dir root, shared by every repo.
//   5. `_shared/.loopover.yml`                  — SHARED BASE (#1959), the lowest-priority layer: one house policy
//      an operator running many repos writes once instead of copy-pasting into every repo's private config.
// `.yaml` / `.json` are accepted everywhere `.yml` is (see CONFIG_BASENAMES). `readFirstExisting` (and its
// `WithPath` sibling) return the first candidate that exists, in list order. With only ONE of {a per-repo
// candidate, the global default, the shared base} present, its raw text is returned unchanged — byte-identical to
// the original #1390 behavior (and to the pre-#1959 2-layer behavior when no shared base is mounted, the common
// case). With more than one present, they are DEEP-MERGED in ascending priority (shared base → global default →
// per-repo file): nested mappings (`gate`, `settings`, `review`, `features`, `contentLane`, and their own nested
// blocks) merge key by key, arrays replace wholesale (never concatenated), and an explicit YAML/JSON `null` at a
// key always overrides a lower layer's value there — which clears a setting wherever the manifest parser already
// treats an explicit null as "off"/"clear" (e.g. `settings.contributorOpenPrCap`, `settings.accountAgeThresholdDays`),
// and is otherwise equivalent to omitting the key. A key that is simply absent from a higher layer leaves the
// lower layer's value at that key untouched. If a layer fails to parse as a YAML/JSON mapping (or is oversized),
// it is dropped from the fold and the remaining, still-valid layers merge as if it were never mounted — a broken
// layer never discards a still-good sibling's policy, and never blocks a review. If NONE of the present layers
// parse, the highest-priority present layer's raw text is returned (matching the original single-candidate
// priority), so a doubly/triply broken set degrades exactly like a single malformed manifest always has. The slug
// is lowercased (GitHub repo full-names are case-insensitive; #1390 already lowercased).
//
// The reserved shared-base folder `_shared` is never treated as a bare repo-name config folder for a real GitHub
// repo named `_shared`; use the owner-qualified or flat owner__repo candidates for that repository instead.
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

/** The bare config filenames tried inside a per-repo folder and at the dir root (global default), in priority
 *  order. Every helper below (`GLOBAL_CONFIG_CANDIDATES`, `SHARED_BASE_CONFIG_CANDIDATES`, `localConfigCandidates`)
 *  derives its search order from this array's order, and `readFirstExisting` / `readFirstExistingWithPath` return
 *  the first candidate that EXISTS. */
const CONFIG_BASENAMES = [".loopover.yml", ".loopover.yaml", ".loopover.json"] as const;

/** The extensions accepted by CONFIG_BASENAMES, in first-seen order: `.yml`, `.yaml`, `.json`. Used only to build
 *  the flat `{owner}__{repo}.<ext>` candidate below (#1390 back-compat), which carries no brand name in it
 *  (`owner__repo.yml`, not `owner__repo.loopover.yml`). */
const CONFIG_EXTENSIONS: string[] = [...new Set(CONFIG_BASENAMES.map((base) => base.slice(base.lastIndexOf("."))))];
const GITHUB_OWNER_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const GITHUB_REPO_SEGMENT = /^[a-z0-9._-]+$/;

function isSafeRepoSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && GITHUB_REPO_SEGMENT.test(segment);
}

/** Global-default candidates (relative to LOOPOVER_REPO_CONFIG_DIR): the dir-root `.loopover.{yml,yaml,json}`,
 *  deep-merged under any per-repo file (or applied alone, when a repo has no per-repo file of its own). */
export const GLOBAL_CONFIG_CANDIDATES: string[] = [...CONFIG_BASENAMES];

/** Shared-base candidates (#1959, relative to LOOPOVER_REPO_CONFIG_DIR): `_shared/.loopover.{yml,yaml,json}`,
 *  sibling to the per-repo folders inside the SAME container-private directory — no new env var. This is the
 *  lowest-priority layer: a cross-repo "house policy" an operator running many repos writes once, deep-merged
 *  UNDER both the global default and any per-repo file (or applied alone, when neither of those exists). */
export const SHARED_BASE_CONFIG_CANDIDATES: string[] = CONFIG_BASENAMES.map((base) => join("_shared", base));
const SHARED_BASE_CONFIG_CANDIDATE_SET = new Set(SHARED_BASE_CONFIG_CANDIDATES);

/** Per-repo private-config candidate paths (relative to LOOPOVER_REPO_CONFIG_DIR), in priority order:
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
    // 1. owner-qualified folder — `{owner}__{repo}/.loopover.{yml,yaml,json}`
    ...CONFIG_BASENAMES.map((base) => join(slug, base)),
    // 2. bare repo-name folder — `{repo}/.loopover.{yml,yaml,json}`
    ...CONFIG_BASENAMES.map((base) => join(repo, base)).filter(
      (candidate) => !SHARED_BASE_CONFIG_CANDIDATE_SET.has(candidate),
    ),
    // 3. flat owner__repo file (#1390) — `{owner}__{repo}.{yml,yaml,json}`
    ...CONFIG_EXTENSIONS.map((ext) => `${slug}${ext}`),
  ];
}

/** Read the first candidate that exists, trying each in order; null when none do. A read error (ENOENT or
 *  otherwise unreadable) is swallowed so the next candidate is tried. */
async function readFirstExisting(base: string, candidates: string[]): Promise<string | null> {
  const hit = await readFirstExistingWithPath(base, candidates);
  return hit?.text ?? null;
}

/** Like {@link readFirstExisting}, but also returns the winning relative candidate path (for provenance). */
async function readFirstExistingWithPath(
  base: string,
  candidates: string[],
): Promise<{ text: string; path: string } | null> {
  for (const candidate of candidates) {
    try {
      return { text: await readFile(resolve(base, candidate), "utf8"), path: candidate };
    } catch {
      // ENOENT / unreadable → try the next candidate
    }
  }
  return null;
}

export type LocalManifestLoadResult = {
  content: string | null;
  /** Relative path under LOOPOVER_REPO_CONFIG_DIR when a shared-base `review:` block contributed (#2046). */
  sharedConfigSource: string | null;
  warnings: string[];
};

const SHARED_BASE_MALFORMED_WARNING =
  "Container-private shared base manifest (`review.shared_config`) is malformed or oversized; ignoring it and continuing (#2046).";

type ConfigLayerKind = "shared" | "global" | "repo";

function stripReviewKey(mapping: Record<string, unknown>): Record<string, unknown> {
  const { review: _review, ...rest } = mapping;
  return rest;
}

function hasReviewKey(mapping: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(mapping, "review");
}

function extractReviewMapping(mapping: Record<string, unknown>): Record<string, unknown> | null {
  const { review } = mapping;
  if (review === undefined || review === null) return null;
  if (typeof review === "object" && !Array.isArray(review)) return review as Record<string, unknown>;
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
 *  `wantedPaths`, etc.) so it composes correctly with the whole `.loopover.yml` schema, present and future, with
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

/** Combine private-config layers with `review.shared_config` provenance (#2046). Non-`review` keys still deep-merge
 *  via {@link mergeConfigOverlay}; the `review` block is folded separately so provenance + warnings stay accurate. */
function combineConfigLayersWithMeta(
  layersAscendingPriority: Array<{ text: string | null; kind: ConfigLayerKind; sourcePath?: string | null }>,
): LocalManifestLoadResult {
  const warnings: string[] = [];
  let sharedConfigSource: string | null = null;
  const present = layersAscendingPriority.filter((layer): layer is { text: string; kind: ConfigLayerKind; sourcePath?: string | null } => layer.text !== null);
  if (present.length === 0) return { content: null, sharedConfigSource: null, warnings };

  const sharedLayer = present.find((layer) => layer.kind === "shared");
  if (sharedLayer && parseConfigMapping(sharedLayer.text) === null) warnings.push(SHARED_BASE_MALFORMED_WARNING);

  const parsedLayers: Array<{ text: string; kind: ConfigLayerKind; mapping: Record<string, unknown>; sourcePath: string | null }> = [];
  for (const layer of present) {
    const mapping = parseConfigMapping(layer.text);
    if (mapping) parsedLayers.push({ text: layer.text, kind: layer.kind, mapping, sourcePath: layer.sourcePath ?? null });
  }

  if (parsedLayers.length === 0) {
    return { content: present[present.length - 1]!.text, sharedConfigSource: null, warnings };
  }
  if (parsedLayers.length === 1) {
    const only = parsedLayers[0]!;
    if (only.kind === "shared" && extractReviewMapping(only.mapping) && only.sourcePath) {
      sharedConfigSource = only.sourcePath;
    }
    return { content: only.text, sharedConfigSource, warnings };
  }

  let mergedBody: Record<string, unknown> = stripReviewKey(parsedLayers[0]!.mapping);
  for (const layer of parsedLayers.slice(1)) {
    mergedBody = mergeConfigOverlay(mergedBody, stripReviewKey(layer.mapping)) as Record<string, unknown>;
  }

  let mergedReview: unknown;
  for (const layer of parsedLayers) {
    if (!hasReviewKey(layer.mapping)) continue;
    const { review } = layer.mapping;
    mergedReview = mergedReview === undefined ? review : mergeConfigOverlay(mergedReview, review);
    if (layer.kind === "shared" && extractReviewMapping(layer.mapping) && layer.sourcePath) sharedConfigSource = layer.sourcePath;
  }
  if (mergedReview !== undefined) mergedBody.review = mergedReview;

  return { content: JSON.stringify(mergedBody), sharedConfigSource, warnings };
}

/** Build the container-local manifest reader over LOOPOVER_REPO_CONFIG_DIR, or null when the dir is unset/blank
 *  (⇒ the loader keeps fetching the public `.loopover.yml`). Looks up the first existing per-repo candidate, the
 *  global-default candidate, and the shared-base candidate (#1959) independently and folds whichever are present
 *  in ascending priority (shared → global → per-repo) via {@link combineConfigLayers}: with only one present, its
 *  raw text is returned unchanged; with two or more, they are deep-merged (see the module header) and returned as
 *  one JSON document; with none present, null (⇒ the loader falls through to the public file). An invalid repo
 *  full name yields no per-repo candidates and is NOT served the global default or the shared base either (it is
 *  never a real webhook repo). */
export function makeLocalManifestReader(dir: string | undefined): RepoFocusManifestFetcher | null {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return null;
  const base = resolve(trimmed);
  return async (repoFullName: string): Promise<LocalManifestLoadResult | null> => {
    const perRepo = localConfigCandidates(repoFullName);
    if (perRepo.length === 0) return null; // invalid repo name → no per-repo file, global default, or shared base
    const [sharedHit, globalText, repoText] = await Promise.all([
      readFirstExistingWithPath(base, SHARED_BASE_CONFIG_CANDIDATES),
      readFirstExisting(base, GLOBAL_CONFIG_CANDIDATES),
      readFirstExisting(base, perRepo),
    ]);
    const loaded = combineConfigLayersWithMeta([
      { text: sharedHit?.text ?? null, kind: "shared", sourcePath: sharedHit?.path ?? null },
      { text: globalText, kind: "global" },
      { text: repoText, kind: "repo" },
    ]);
    if (loaded.content === null && loaded.warnings.length === 0 && loaded.sharedConfigSource === null) return null;
    return loaded;
  };
}

/** Per-repo review-context candidate FOLDERS (relative to LOOPOVER_REPO_CONFIG_DIR): `{owner}__{repo}/review` then
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

/** Build the container-local review-context reader over LOOPOVER_REPO_CONFIG_DIR, or null when the dir is unset. Per
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
