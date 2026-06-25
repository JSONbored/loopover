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
  /** Frontmatter fields whose edit on a MODIFIED entry is a protected close — identity / provenance /
   *  verification / structural / monetization + supply-chain links. */
  protectedFrontmatterFields: ReadonlySet<string>;
  /** URL-bearing frontmatter keys (camelCase + snake_case) normalized + compared for duplicate detection. */
  urlFields: ReadonlySet<string>;
  /** Generic ecosystem hosts that never make a strict/aggressive domain-only match (a shared one is at most "related"). */
  domainOnlyExclusions: ReadonlySet<string>;
  /** Catalog roots that legitimately back MANY entries; a shared root alone is never strict (only a shared subpath). */
  multiEntryCatalogUrls: ReadonlySet<string>;
  /** Scalar source-URL frontmatter fields, in extraction ORDER (the source-evidence gate reads them in sequence). */
  sourceUrlFields: readonly string[];
  /** Array-valued source-URL frontmatter fields (e.g. retrievalSources/sourceUrls) read as real source evidence. */
  sourceUrlListFields: ReadonlySet<string>;
  /** Source fields treated as distribution (download/package) rather than canonical provenance. */
  distributionSourceFields: ReadonlySet<string>;
  /** Hosts that classify any source URL as distribution regardless of field (package registries / artifact hosts). */
  distributionSourceHosts: ReadonlySet<string>;
  /** Canonical fields that anchor the close decision + block inconclusive-downgrade (the primary provenance links). */
  primaryCanonicalSourceFields: ReadonlySet<string>;
}

/** The default curated-list spec — awesome-claude's categories, entry layout, and maintenance branches. */
export const AWESOME_CLAUDE_CONTENT_SPEC: ContentRepoSpec = {
  categories: new Set(["agents", "collections", "commands", "guides", "hooks", "mcp", "rules", "skills", "statuslines", "tools"]),
  entryPathPattern: /^content\/([^/]+)\/([^/]+)\.mdx$/i,
  maintenanceBranchPrefixes: ["links/"],
  // PROTECTED = identity / provenance / verification / structural / monetization + supply-chain links. The entry's
  // own REFERENCE/DOCS URLs are deliberately NOT protected (those links rot + legitimately need fixing); download/
  // package/affiliate URLs stay protected (supply-chain / monetization risk).
  protectedFrontmatterFields: new Set([
    "affiliateUrl",
    "author",
    "authorProfileUrl",
    "category",
    "claimStatus",
    "claimUrl",
    "dateAdded",
    "disclosure",
    "downloadUrl",
    "importPrNumber",
    "importPrUrl",
    "packageUrl",
    "packageVerified",
    "pricingModel",
    "reviewedAt",
    "reviewedBy",
    "reviewedPrNumber",
    "slug",
    "submittedAt",
    "submittedBy",
    "submittedByUrl",
    "sourceSubmissionNumber",
    "sourceSubmissionUrl",
  ]),
  urlFields: new Set([
    "documentationUrl",
    "docsUrl",
    "downloadUrl",
    "githubUrl",
    "packageUrl",
    "repoUrl",
    "repositoryUrl",
    "sourceUrl",
    "websiteUrl",
    "docs_url",
    "download_url",
    "github_url",
    "package_url",
    "repo_url",
    "repository_url",
    "source_url",
    "website_url",
  ]),
  domainOnlyExclusions: new Set(["github.com", "npmjs.com", "pypi.org", "raw.githubusercontent.com", "registry.npmjs.org"]),
  multiEntryCatalogUrls: new Set([
    "https://code.claude.com/docs/en/hooks",
    "https://code.claude.com/docs/en/statusline",
    "https://github.com/awslabs/mcp",
    "https://github.com/microsoft/mcp",
    "https://github.com/modelcontextprotocol/servers",
    "https://github.com/snowflake-labs/mcp",
    "https://github.com/twilio-labs/mcp",
  ]),
  sourceUrlFields: [
    "documentationUrl",
    "docsUrl",
    "downloadUrl",
    "githubUrl",
    "packageUrl",
    "repoUrl",
    "repositoryUrl",
    "sourceUrl",
    "websiteUrl",
  ],
  sourceUrlListFields: new Set(["sourceUrls", "retrievalSources"]),
  distributionSourceFields: new Set(["downloadUrl", "packageUrl"]),
  distributionSourceHosts: new Set([
    "crates.io",
    "files.pythonhosted.org",
    "hub.docker.com",
    "marketplace.visualstudio.com",
    "mvnrepository.com",
    "npmjs.com",
    "packagist.org",
    "pkg.go.dev",
    "plugins.gradle.org",
    "pypi.org",
    "registry.npmjs.org",
    "repo1.maven.org",
    "rubygems.org",
    "www.npmjs.com",
  ]),
  primaryCanonicalSourceFields: new Set(["githubUrl", "repoUrl", "repositoryUrl", "sourceUrl"]),
};
