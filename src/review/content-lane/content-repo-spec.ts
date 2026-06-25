// Modular content-repository configuration for the curated-list content lane (the awesome-claude lane and any
// self-hosted curated list). The curated-list analogue of RegistryLaneSpec (the metagraphed registry lane): a
// maintainer whose list uses different categories or a different entry-file layout parameterizes the lane via
// config instead of a gittensory code change. Defaults preserve the awesome-claude behaviour byte-for-byte.
//
// This is a LEAF module (no content-lane imports) so every consumer — scope, duplicates, source-evidence — can
// import the spec without an import cycle. Fields are added here as each consumer is migrated.
export interface ContentRepoSpec {
  /** The content categories the list accepts (the first path segment under the entry root). */
  categories: ReadonlySet<string>;
  /** Matches one content entry file, capturing [category, slug] — e.g. /^content\/([^/]+)\/([^/]+)\.mdx$/i. */
  entryPathPattern: RegExp;
  /** Head-branch prefixes used by bulk maintenance automation (link-health, etc.); these legitimately edit many
   *  entries in one PR and are ignored, never closed. */
  maintenanceBranchPrefixes: readonly string[];
}

/** The default curated-list spec — awesome-claude's categories, entry layout, and maintenance branches. */
export const AWESOME_CLAUDE_CONTENT_SPEC: ContentRepoSpec = {
  categories: new Set(["agents", "collections", "commands", "guides", "hooks", "mcp", "rules", "skills", "statuslines", "tools"]),
  entryPathPattern: /^content\/([^/]+)\/([^/]+)\.mdx$/i,
  maintenanceBranchPrefixes: ["links/"],
};
