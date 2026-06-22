// Content scope classification (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to reviewbot's
// src/agents/awesome-claude/review-logic.ts (itself a faithful port of the live submission-gate
// classifyPullRequestFilesForContentReview). PURE — distinguishes ignore (no content entry) vs
// scope_failure (CLOSE) vs deletion vs review. `slugify` is inlined (a one-liner) so the module
// has zero imports.

const MAX_SLUG_INPUT_CHARS = 4096;

/** Inlined from reviewbot core/draft.ts slugify — a pure string→slug transform. */
function slugify(value: unknown): string {
  return String(value ?? "")
    .slice(0, MAX_SLUG_INPUT_CHARS)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export const SUPPORTED_CONTENT_CATEGORIES = new Set([
  "agents",
  "collections",
  "commands",
  "guides",
  "hooks",
  "mcp",
  "rules",
  "skills",
  "statuslines",
  "tools",
]);

const CONTENT_ENTRY = /^content\/([^/]+)\/([^/]+)\.mdx$/i;

export function importContentPathParts(filePath: string): { category: string; slug: string } | null {
  const match = CONTENT_ENTRY.exec(filePath);
  if (!match) return null;
  return { category: (match[1] as string).toLowerCase(), slug: slugify(match[2]) };
}

export interface ContentFile {
  filename: string;
  status?: string;
}

export interface ContentScope {
  category: string;
  slug: string;
  file: string;
  status: string;
}

export type ContentClassification =
  | { kind: "ignore"; reason: string }
  | { kind: "close"; category?: string; reason: string }
  | { kind: "deletion"; category: string; slug: string; file: string }
  | ({ kind: "review" } & ContentScope);

const SCOPE_MULTI =
  "Direct content submissions must change exactly one source content file and no generated artifacts, README, workflows, scripts, packages, or additional entries.";
const SCOPE_STATUS =
  "Direct content submissions can only add a new content file or edit one existing content file. Deletes, renames, and generated-artifact updates are not accepted in this path.";

// Branch prefixes the automated link-health routine uses for its bulk URL-canonicalization PRs —
// these LEGITIMATELY edit many content files and should be ignored, never closed.
const MAINTENANCE_BRANCH_PREFIXES = ["links/"];
function isMaintenanceBranch(headRef?: string): boolean {
  if (!headRef) return false;
  const ref = headRef.toLowerCase();
  return MAINTENANCE_BRANCH_PREFIXES.some((p) => ref.startsWith(p));
}

/** Exact port of classifyPullRequestFilesForContentReview. */
export function classifyContentFiles(
  files: ContentFile[],
  context: { headRepo?: string; baseRepo?: string; headRef?: string } = {},
): ContentClassification {
  const entryFiles = files
    .map((file) => ({ file, pathParts: importContentPathParts(String(file.filename || "")) }))
    .filter((item): item is { file: ContentFile; pathParts: { category: string; slug: string } } =>
      Boolean(item.pathParts),
    );

  if (entryFiles.length === 0) {
    return { kind: "ignore", reason: "No source content entry file changed." };
  }

  if (files.length !== 1 || entryFiles.length !== 1) {
    const sameRepo =
      !!context.headRepo && !!context.baseRepo && context.headRepo.toLowerCase() === context.baseRepo.toLowerCase();
    // 1. A dedicated same-repo maintenance branch legitimately edits many content files → ignore.
    if (sameRepo && isMaintenanceBranch(context.headRef)) {
      return {
        kind: "ignore",
        reason: "Same-repository maintenance branch; the gate reviews only exact one-file content submissions.",
      };
    }
    // 2a. Same-repo PR that ONLY deletes content files = a maintainer dedup/cleanup → ignore (advisory).
    if (sameRepo && entryFiles.length > 1 && entryFiles.every((e) => String(e.file.status) === "removed")) {
      return { kind: "ignore", reason: "Same-repository multi-file deletion; treated as maintainer cleanup." };
    }
    // exactOptionalPropertyTypes: only include `category` when one is actually present.
    const firstCategory = entryFiles[0]?.pathParts?.category;
    const multiClose: ContentClassification =
      firstCategory !== undefined
        ? { kind: "close", category: firstCategory, reason: SCOPE_MULTI }
        : { kind: "close", reason: SCOPE_MULTI };
    // 2b. TWO+ content entries in one PR is a content-submission MISTAKE → close with one-file guidance.
    if (entryFiles.length > 1) {
      return multiClose;
    }
    // 3. A single content entry bundled with non-content files: same-repo → ignore (advisory); fork → close.
    if (sameRepo) {
      return {
        kind: "ignore",
        reason: "Mixed same-repository maintenance PR; the gate reviews only exact one-file content submissions.",
      };
    }
    return multiClose;
  }

  const entry = entryFiles[0] as { file: ContentFile; pathParts: { category: string; slug: string } };
  const parts = entry.pathParts;
  if (!SUPPORTED_CONTENT_CATEGORIES.has(parts.category)) {
    return {
      kind: "close",
      category: parts.category,
      reason: `Unsupported content category \`${parts.category}\`. Supported categories are ${[...SUPPORTED_CONTENT_CATEGORIES].sort().join(", ")}.`,
    };
  }

  const status = String(entry.file.status || "");
  // A delete-only content PR (removing exactly one entry) is a VALID maintainer action, NOT a scope
  // failure. Route it to the deletion disposition. A rename arrives as two entries → the multi path.
  if (status === "removed") {
    return { kind: "deletion", category: parts.category, slug: parts.slug, file: String(entry.file.filename) };
  }
  if (!["added", "modified"].includes(status)) {
    return { kind: "close", category: parts.category, reason: SCOPE_STATUS };
  }

  return { kind: "review", category: parts.category, slug: parts.slug, file: String(entry.file.filename), status };
}

/** Cheap pre-check used in the classify phase: does this PR touch a content entry file at all? */
export function touchesContentEntry(filenames: string[]): boolean {
  return filenames.some((f) => CONTENT_ENTRY.test(f));
}
