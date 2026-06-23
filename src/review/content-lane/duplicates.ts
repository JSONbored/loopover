// Deterministic duplicate-detection + protected-edit content gate (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to reviewbot's
// src/agents/awesome-claude/duplicates.ts (itself a faithful port of the live submission-gate
// duplicates.ts). This module is I/O-free: the caller fetches the accepted corpus
// (`${PUBLIC_SITE_URL}/data/directory-index.json`) and any earlier-open-PR content, then passes
// the already-fetched data here for comparison.
//
// Normalization, the STRICT-match rule (the only result the gate closes on), the related/legacy
// classifiers, and the protected-field set are preserved exactly. Over-closing (a false strict
// duplicate) permanently rejects a legitimate submission, so the strict boundary is unchanged.
// The only deltas vs the reviewbot source are mechanical guards for gittensory's stricter tsconfig
// (noUncheckedIndexedAccess + exactOptionalPropertyTypes) — they do not change behavior.

export type ContentDuplicateSignals = {
  filePath: string;
  category: string;
  slug: string;
  title: string;
  normalizedTitle: string;
  normalizedDescription: string;
  urls: string[];
  domains: string[];
  label?: string;
  url?: string;
};

export type ContentDuplicateMatch = {
  existing: ContentDuplicateSignals;
  reasons: string[];
};

export type ContentDuplicateReview = {
  legacyDuplicate: ContentDuplicateMatch | null;
  strictDuplicate: ContentDuplicateMatch | null;
  relatedCandidates: ContentDuplicateMatch[];
};

// ── Protected frontmatter (identity / provenance / source / verification) ─────────────────
// An edit to ANY of these fields (modified PR only) → protected close. PROTECTED = identity /
// provenance / verification / structural / monetization + supply-chain links. The entry's own
// REFERENCE/DOCS URLs are deliberately NOT protected — those links rot and legitimately need
// fixing, and a changed URL flows through the normal review (grounding re-fetches it). down
// loadUrl/packageUrl/affiliateUrl stay protected (supply-chain/monetization risk).
const PROTECTED_FRONTMATTER_FIELDS = new Set([
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
]);

// URL-bearing frontmatter keys, camelCase + snake_case.
const URL_FIELDS = new Set([
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
]);

// Generic ecosystem hosts that never make a strict/aggressive domain-only match. A SHARED domain
// here is, at most, "related".
const DOMAIN_ONLY_EXCLUSIONS = new Set([
  "github.com",
  "npmjs.com",
  "pypi.org",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
]);

// Catalog roots that legitimately back MANY entries; a shared root alone is never a strict
// duplicate (only a shared distinct subpath can be).
const MULTI_ENTRY_CATALOG_URLS = new Set([
  "https://code.claude.com/docs/en/hooks",
  "https://code.claude.com/docs/en/statusline",
  "https://github.com/awslabs/mcp",
  "https://github.com/microsoft/mcp",
  "https://github.com/modelcontextprotocol/servers",
  "https://github.com/snowflake-labs/mcp",
  "https://github.com/twilio-labs/mcp",
]);

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/**
 * Parse YAML frontmatter into a flat key→string map, capturing each top-level field's value
 * REGARDLESS of scalar style — inline, quoted, block literal (`|`), folded (`>`), or a block/flow
 * sequence. A regex parser that silently DROPS block/folded/list values would let a contributor
 * hide a protected-field edit and bypass the protected-edit + duplicate gates. Values are
 * normalized to a comparable string (block lines joined); enough for change-detection + signal
 * extraction without a full YAML dependency.
 */
export function parseSimpleFrontmatter(source: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(source || ""));
  const fields: Record<string, string> = {};
  if (!match) return fields;
  /* v8 ignore next -- noUncheckedIndexedAccess fallback: capture group 1 always participates when the regex matches, so match[1] is never undefined */
  const lines = (match[1] ?? "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    /* v8 ignore next -- noUncheckedIndexedAccess fallback: i < lines.length guards the index and split() never yields undefined elements */
    const head = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(lines[i] ?? "");
    if (!head) {
      i += 1;
      continue;
    }
    const key = head[1] as string;
    /* v8 ignore next -- noUncheckedIndexedAccess fallback: capture group 2 (.*) always participates when head matches, so head[2] is never undefined */
    const inline = (head[2] ?? "").trim();
    i += 1;
    if (/^[|>][+-]?\d*$/.test(inline)) {
      // Block literal (`|`) / folded (`>`) scalar: gather the indented block that follows.
      const block: string[] = [];
      /* v8 ignore next -- noUncheckedIndexedAccess fallback: i < lines.length guards the index; split() elements are always strings */
      while (i < lines.length && ((lines[i] ?? "").trim() === "" || /^\s/.test(lines[i] ?? ""))) {
        /* v8 ignore next -- noUncheckedIndexedAccess fallback: loop guard keeps i in bounds; split() elements are always strings */
        block.push((lines[i] ?? "").replace(/^\s+/, ""));
        i += 1;
      }
      fields[key] = block.join(inline.startsWith(">") ? " " : "\n").trim();
    } else if (inline === "") {
      // Block/flow sequence or nested map on the following indented lines.
      const items: string[] = [];
      /* v8 ignore next -- noUncheckedIndexedAccess fallback: the second lines[i] reuses the same in-bounds index already validated by /^\s/.test above */
      while (i < lines.length && /^\s/.test(lines[i] ?? "") && (lines[i] ?? "").trim() !== "") {
        /* v8 ignore next -- noUncheckedIndexedAccess fallback: loop guard keeps i in bounds; split() elements are always strings */
        items.push((lines[i] ?? "").replace(/^\s*-\s*/, "").trim());
        i += 1;
      }
      fields[key] = items.join(", ");
    } else {
      fields[key] = unquoteYamlScalar(inline);
    }
  }
  return fields;
}

/**
 * Top-level frontmatter keys that appear MORE THAN ONCE. The site build parses frontmatter with
 * gray-matter (js-yaml), which THROWS `duplicated mapping key` and crashes the content-index build
 * → every deploy fails. The lenient parser above silently keeps the LAST value, so a duplicate-key
 * file could pass review and break all builds. This deterministically catches it, mirroring the
 * parser's block-scalar / sequence skipping. Scoped to top-level keys (indent 0).
 */
export function findDuplicateFrontmatterKeys(source: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(source || ""));
  if (!match) return [];
  /* v8 ignore next -- noUncheckedIndexedAccess fallback: capture group 1 always participates when the regex matches, so match[1] is never undefined */
  const lines = (match[1] ?? "").split(/\r?\n/);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    /* v8 ignore next -- noUncheckedIndexedAccess fallback: i < lines.length guards the index and split() never yields undefined elements */
    const head = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(lines[i] ?? "");
    if (!head) {
      i += 1;
      continue;
    }
    const key = head[1] as string;
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
    /* v8 ignore next -- noUncheckedIndexedAccess fallback: capture group 2 (.*) always participates when head matches, so head[2] is never undefined */
    const inline = (head[2] ?? "").trim();
    i += 1;
    if (/^[|>][+-]?\d*$/.test(inline)) {
      /* v8 ignore next -- noUncheckedIndexedAccess fallback: i < lines.length guards the index; split() elements are always strings */
      while (i < lines.length && ((lines[i] ?? "").trim() === "" || /^\s/.test(lines[i] ?? ""))) i += 1;
    } else if (inline === "") {
      /* v8 ignore next -- noUncheckedIndexedAccess fallback: the second lines[i] reuses the same in-bounds index already validated by /^\s/.test */
      while (i < lines.length && /^\s/.test(lines[i] ?? "") && (lines[i] ?? "").trim() !== "") i += 1;
    }
  }
  return [...dupes];
}

/** Style-insensitive normalization for protected-field comparison: unquote + collapse interior
 *  whitespace. So the SAME logical value written in a different scalar style does NOT register as a
 *  change and falsely hard-close a benign edit — while a genuine content change still differs. */
function normalizeProtectedValue(value: string | undefined): string {
  return unquoteYamlScalar(String(value ?? "")).replace(/\s+/g, " ").trim();
}

/**
 * Protected-edit gate. Compares before/after frontmatter and returns the sorted set of protected
 * fields that changed. A non-empty result → protected close.
 */
export function protectedFrontmatterChanges(beforeSource: string, afterSource: string): string[] {
  const before = parseSimpleFrontmatter(beforeSource);
  const after = parseSimpleFrontmatter(afterSource);
  return [...PROTECTED_FRONTMATTER_FIELDS]
    .filter((field) => normalizeProtectedValue(before[field]) !== normalizeProtectedValue(after[field]))
    .sort();
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function normalizeUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.protocol = "https:";
    parsed.hostname = normalizeHostname(parsed.hostname);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.startsWith("utm_") ||
        ["affiliate", "affiliate_id", "campaign", "ref", "referral", "referral_code", "source", "via"].includes(
          normalizedKey,
        )
      ) {
        parsed.searchParams.delete(key);
      }
    }

    if (parsed.hostname === "github.com") {
      const [owner, repo, ...rest] = parsed.pathname.split("/").filter(Boolean);
      if (owner && repo) {
        const repoRoot = `https://github.com/${owner.toLowerCase()}/${repo.replace(/\.git$/i, "").toLowerCase()}`;
        if (MULTI_ENTRY_CATALOG_URLS.has(repoRoot) && rest.length) {
          return `${repoRoot}/${rest.join("/").replace(/\/+$/, "")}`;
        }
        return repoRoot;
      }
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function domainFromUrl(value: string): string {
  try {
    return normalizeHostname(new URL(value).hostname);
  } catch {
    /* v8 ignore next -- unreachable: callers only pass already-normalized valid http(s) URLs, so new URL never throws here */
    return "";
  }
}

function pathParts(filePath: string): { category: string; slug: string } {
  const match = /^content\/([^/]+)\/([^/]+)\.mdx$/i.exec(filePath);
  return {
    category: match?.[1]?.toLowerCase() || "",
    slug: match?.[2]?.toLowerCase() || "",
  };
}

/**
 * Candidate-signal extraction. Derives the comparable signal set from one entry's frontmatter +
 * content path: slug, title, normalizedTitle, normalizedDescription, the deduped normalized URL
 * set, and the domains derived from those URLs.
 */
export function extractContentDuplicateSignals(params: {
  filePath: string;
  content: string;
  label?: string;
  url?: string;
}): ContentDuplicateSignals {
  const fields = parseSimpleFrontmatter(params.content);
  const parts = pathParts(params.filePath);
  const urls = [
    ...new Set(
      Object.entries(fields)
        .filter(([key]) => URL_FIELDS.has(key))
        .map(([, value]) => normalizeUrl(value))
        .filter(Boolean),
    ),
  ];

  return {
    filePath: params.filePath,
    category: normalizeText(fields.category) || parts.category,
    slug: normalizeText(fields.slug).replace(/\s+/g, "-") || parts.slug,
    title: fields.title || "",
    normalizedTitle: normalizeText(fields.title),
    normalizedDescription: normalizeText(fields.description),
    urls,
    domains: [...new Set(urls.map(domainFromUrl).filter(Boolean))],
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.url !== undefined ? { url: params.url } : {}),
  };
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function strictDuplicateUrls(sharedUrls: string[]): string[] {
  return sharedUrls.filter((url) => !MULTI_ENTRY_CATALOG_URLS.has(url));
}

function multiEntryCatalogRoot(url: string): string | undefined {
  return [...MULTI_ENTRY_CATALOG_URLS].find((catalogUrl) => url === catalogUrl || url.startsWith(`${catalogUrl}/`));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function multiEntryCatalogSubpathUrls(sharedUrls: string[]): string[] {
  return sharedUrls.filter((url) => {
    const catalogUrl = multiEntryCatalogRoot(url);
    return catalogUrl && url !== catalogUrl;
  });
}

function sharedCatalogUrls(leftUrls: string[], rightUrls: string[]): string[] {
  const leftCatalogUrls = leftUrls.map(multiEntryCatalogRoot).filter(isString);
  const rightCatalogUrls = rightUrls.map(multiEntryCatalogRoot).filter(isString);
  return intersection([...new Set(leftCatalogUrls)], [...new Set(rightCatalogUrls)]);
}

function isCollectionBridge(candidate: ContentDuplicateSignals, existing: ContentDuplicateSignals): boolean {
  return (
    candidate.category !== existing.category &&
    (candidate.category === "collections" || existing.category === "collections")
  );
}

/**
 * Legacy (aggressive, non-blocking) duplicate classifier. Kept for advisory output only — the
 * gate does NOT close on this; it closes on strictDuplicate.
 */
export function findContentDuplicateMatch(
  candidate: ContentDuplicateSignals,
  existingItems: ContentDuplicateSignals[],
): ContentDuplicateMatch | null {
  for (const existing of existingItems) {
    const reasons: string[] = [];
    if (candidate.filePath === existing.filePath) {
      reasons.push(`same content path \`${existing.filePath}\``);
    }
    if (candidate.category && candidate.slug && candidate.category === existing.category && candidate.slug === existing.slug) {
      reasons.push(`same ${candidate.category} slug \`${candidate.slug}\``);
    }

    const sharedUrls = intersection(candidate.urls, existing.urls);
    if (sharedUrls.length) {
      reasons.push(`same canonical source URL ${sharedUrls[0]}`);
    }

    if (
      candidate.category &&
      candidate.normalizedTitle &&
      candidate.category === existing.category &&
      candidate.normalizedTitle === existing.normalizedTitle
    ) {
      reasons.push(`same normalized title in ${candidate.category}`);
    }

    if (
      candidate.category &&
      candidate.normalizedDescription &&
      candidate.category === existing.category &&
      candidate.normalizedDescription === existing.normalizedDescription
    ) {
      reasons.push(`same normalized description in ${candidate.category}`);
    }

    const sharedDomains = intersection(candidate.domains, existing.domains);
    if (sharedDomains.length && candidate.normalizedTitle && candidate.normalizedTitle === existing.normalizedTitle) {
      reasons.push(`same source domain ${sharedDomains[0]} and title`);
    }
    const aggressiveDomainMatch = sharedDomains.find((domain) => !DOMAIN_ONLY_EXCLUSIONS.has(domain));
    if (aggressiveDomainMatch && candidate.category && candidate.category === existing.category) {
      reasons.push(`same non-generic source domain ${aggressiveDomainMatch} in ${candidate.category}`);
    }

    if (reasons.length) return { existing, reasons };
  }
  return null;
}

/**
 * STRICT (blocking) duplicate rule. The ONLY result the gate closes on. A candidate is a strict
 * duplicate of an existing item iff ANY of:
 *   1. same content path  (`content/<cat>/<slug>.mdx`)
 *   2. same category + same slug
 *   3. same category + a shared blocking source URL that is a distinct multi-entry-catalog SUBPATH
 *   4. same category + a shared blocking source URL + same normalized description
 *   5. (collections only) ≥2 shared blocking source URLs between two collections
 * Mere shared domain / shared ecosystem host / shared catalog ROOT is NOT strict.
 */
export function findStrictContentDuplicateMatch(
  candidate: ContentDuplicateSignals,
  existingItems: ContentDuplicateSignals[],
): ContentDuplicateMatch | null {
  for (const existing of existingItems) {
    const reasons: string[] = [];
    if (candidate.filePath === existing.filePath) {
      reasons.push(`same content path \`${existing.filePath}\``);
    }
    if (candidate.category && candidate.slug && candidate.category === existing.category && candidate.slug === existing.slug) {
      reasons.push(`same ${candidate.category} slug \`${candidate.slug}\``);
    }

    const sharedUrls = intersection(candidate.urls, existing.urls);
    const blockingSharedUrls = strictDuplicateUrls(sharedUrls);
    const catalogSubpathUrls = multiEntryCatalogSubpathUrls(blockingSharedUrls);
    if (catalogSubpathUrls.length && candidate.category && candidate.category === existing.category) {
      reasons.push(`same multi-entry catalog subpath URL ${catalogSubpathUrls[0]}`);
    }
    if (
      blockingSharedUrls.length &&
      candidate.category &&
      candidate.category === existing.category &&
      candidate.normalizedDescription &&
      candidate.normalizedDescription === existing.normalizedDescription
    ) {
      reasons.push(`same canonical source URL ${blockingSharedUrls[0]} and same normalized description`);
    }
    if (blockingSharedUrls.length >= 2 && candidate.category === "collections" && existing.category === "collections") {
      reasons.push(`same collection source set including ${blockingSharedUrls[0]}`);
    }

    if (reasons.length) return { existing, reasons };
  }
  return null;
}

/**
 * Related (non-blocking) classifier. Surfaces cross-category overlaps, shared catalog roots, shared
 * non-generic domains, and same-category title/description matches as advisory context. These are
 * explicitly NOT strict duplicates.
 */
export function findRelatedContentMatches(
  candidate: ContentDuplicateSignals,
  existingItems: ContentDuplicateSignals[],
  limit = 5,
): ContentDuplicateMatch[] {
  const matches: ContentDuplicateMatch[] = [];
  for (const existing of existingItems) {
    const reasons: string[] = [];
    if (candidate.filePath === existing.filePath) continue;

    const sharedUrls = intersection(candidate.urls, existing.urls);
    if (sharedUrls.length && candidate.category !== existing.category) {
      reasons.push(
        isCollectionBridge(candidate, existing)
          ? `same canonical source URL ${sharedUrls[0]} across collection/resource categories`
          : `same canonical source URL ${sharedUrls[0]} across ${candidate.category}/${existing.category}`,
      );
    } else if (sharedUrls.length && candidate.category && candidate.category === existing.category) {
      reasons.push(
        `same canonical source URL ${sharedUrls[0]} in ${candidate.category}, but not a strict duplicate without the same title, slug, or purpose`,
      );
    }
    const catalogUrls = sharedCatalogUrls(candidate.urls, existing.urls);
    if (catalogUrls.length && candidate.category && candidate.category === existing.category) {
      reasons.push(`same multi-entry catalog source URL ${catalogUrls[0]} in ${candidate.category}`);
    }

    const sharedDomains = intersection(candidate.domains, existing.domains);
    const relatedDomain = sharedDomains.find((domain) => !DOMAIN_ONLY_EXCLUSIONS.has(domain));
    if (relatedDomain && candidate.category && existing.category) {
      reasons.push(
        candidate.category === existing.category
          ? `same non-generic source domain ${relatedDomain} in ${candidate.category}`
          : `same non-generic source domain ${relatedDomain} across ${candidate.category}/${existing.category}`,
      );
    }

    if (
      candidate.category &&
      candidate.normalizedTitle &&
      candidate.category === existing.category &&
      candidate.normalizedTitle === existing.normalizedTitle
    ) {
      reasons.push(
        `same normalized title in ${candidate.category}, but not a strict duplicate without the same slug, path, source, or purpose`,
      );
    }

    if (
      candidate.category &&
      candidate.normalizedDescription &&
      candidate.category === existing.category &&
      candidate.normalizedDescription === existing.normalizedDescription
    ) {
      reasons.push(`same normalized description in ${candidate.category}`);
    }

    if (reasons.length) {
      matches.push({ existing, reasons });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

/**
 * Combined review. The caller closes on `strictDuplicate`; the legacy + related outputs are
 * advisory only.
 */
export function buildContentDuplicateReview(
  candidate: ContentDuplicateSignals,
  existingItems: ContentDuplicateSignals[],
): ContentDuplicateReview {
  return {
    legacyDuplicate: findContentDuplicateMatch(candidate, existingItems),
    strictDuplicate: findStrictContentDuplicateMatch(candidate, existingItems),
    relatedCandidates: findRelatedContentMatches(candidate, existingItems),
  };
}

// ── directory-index adapter ───────────────────────────────────────────────────────────────
// The accepted corpus is the PUBLIC `${PUBLIC_SITE_URL}/data/directory-index.json` payload (shape
// { entries: Array<DirectoryIndexEntry> }). We synthesize a frontmatter block per entry and run
// the SAME extractContentDuplicateSignals path so corpus signals are identical to candidate signals.

/** Loose entry shape from directory-index.json — only the fields we read are typed. */
export type DirectoryIndexEntry = Record<string, unknown> & {
  category?: unknown;
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  canonicalUrl?: unknown;
};

/** URL signal fields read off a directory entry, in order. */
const DIRECTORY_ENTRY_URL_SIGNAL_FIELDS = [
  "documentationUrl",
  "docsUrl",
  "downloadUrl",
  "githubUrl",
  "packageUrl",
  "repoUrl",
  "repositoryUrl",
  "sourceUrl",
  "websiteUrl",
] as const;

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value || ""));
}

/** Synthesize the per-entry frontmatter block. */
function contentSignalSourceFromDirectoryEntry(entry: DirectoryIndexEntry): string {
  const lines = [
    "---",
    `title: ${yamlScalar(entry.title)}`,
    `description: ${yamlScalar(entry.description)}`,
    `category: ${yamlScalar(entry.category)}`,
    `slug: ${yamlScalar(entry.slug)}`,
  ];
  for (const field of DIRECTORY_ENTRY_URL_SIGNAL_FIELDS) {
    const value = entry[field];
    if (value) lines.push(`${field}: ${yamlScalar(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Adapter: directory-index entries → corpus signals. Entries without a category+slug are dropped;
 * the synthetic content path is `content/<category>/<slug>.mdx`; the candidate's own file path is
 * excluded when supplied; label/url match the live worker (canonicalUrl, else `${siteUrl}/entry/...`).
 */
export function directoryIndexToSignals(
  entries: DirectoryIndexEntry[],
  options: { currentFilePath?: string; siteUrl?: string } = {},
): ContentDuplicateSignals[] {
  const siteUrl = options.siteUrl ?? "";
  const currentFilePath = options.currentFilePath;
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const category = String(entry.category || "").trim();
      const slug = String(entry.slug || "").trim();
      if (!category || !slug) return null;
      const filePath = `content/${category}/${slug}.mdx`;
      return { entry, filePath };
    })
    .filter((item): item is { entry: DirectoryIndexEntry; filePath: string } => Boolean(item))
    .filter(({ filePath }) => filePath !== currentFilePath)
    .map(({ entry, filePath }) =>
      extractContentDuplicateSignals({
        filePath,
        content: contentSignalSourceFromDirectoryEntry(entry),
        label: `accepted entry ${filePath}`,
        url: String(entry.canonicalUrl || "") || `${siteUrl}/entry/${String(entry.category)}/${String(entry.slug)}`,
      }),
    );
}
