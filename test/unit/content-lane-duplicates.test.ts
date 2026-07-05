import { describe, expect, it } from "vitest";
import {
  buildContentDuplicateReview,
  directoryIndexToSignals,
  extractContentDuplicateSignals,
  findContentDuplicateMatch,
  findDuplicateFrontmatterKeys,
  findRelatedContentMatches,
  findStrictContentDuplicateMatch,
  parseSimpleFrontmatter,
  protectedFrontmatterChanges,
} from "../../src/review/content-lane/duplicates";
import { AWESOME_CLAUDE_CONTENT_SPEC, type ContentRepoSpec } from "../../src/review/content-lane/content-repo-spec";

const customSpec = (over: Partial<ContentRepoSpec>): ContentRepoSpec => ({ ...AWESOME_CLAUDE_CONTENT_SPEC, ...over });

const mdx = (frontmatter: Record<string, string>, body = "Body."): string => {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
};

describe("parseSimpleFrontmatter", () => {
  it("parses inline, quoted, block-literal, folded, and sequence values", () => {
    const src = [
      "---",
      'title: "My Title"',
      "slug: my-title",
      "desc: |",
      "  line one",
      "  line two",
      "folded: >",
      "  a b",
      "  c d",
      "tags:",
      "  - one",
      "  - two",
      "---",
      "",
      "body",
    ].join("\n");
    const f = parseSimpleFrontmatter(src);
    expect(f.title).toBe("My Title");
    expect(f.slug).toBe("my-title");
    expect(f.desc).toBe("line one\nline two");
    expect(f.folded).toBe("a b c d");
    expect(f.tags).toBe("one, two");
  });

  it("returns {} for content without frontmatter", () => {
    expect(parseSimpleFrontmatter("no frontmatter here")).toEqual({});
  });

  it("skips non-key lines (blank / comment / continuation) without crashing (lines 139-140)", () => {
    const src = ["---", "", "# a yaml comment", "  indented orphan", "title: Real", "---", "", "body"].join("\n");
    const f = parseSimpleFrontmatter(src);
    // The leading blank, the comment, and the stray indented line don't match the key regex → continue.
    expect(f.title).toBe("Real");
    expect(Object.keys(f)).toEqual(["title"]);
  });
});

describe("findDuplicateFrontmatterKeys", () => {
  it("catches a repeated top-level key (would crash the gray-matter build)", () => {
    const src = "---\ntitle: A\nslug: a\ntitle: B\n---\n\nbody";
    expect(findDuplicateFrontmatterKeys(src)).toContain("title");
  });

  it("returns [] when keys are unique", () => {
    expect(findDuplicateFrontmatterKeys(mdx({ title: "A", slug: "a" }))).toEqual([]);
  });

  it("returns [] for falsy/empty source (source || \"\" fallback, no frontmatter match)", () => {
    // Exercises the `String(source || "")` falsy branch on the empty string and a coerced-falsy value.
    expect(findDuplicateFrontmatterKeys("")).toEqual([]);
    expect(findDuplicateFrontmatterKeys(undefined as unknown as string)).toEqual([]);
    expect(findDuplicateFrontmatterKeys(0 as unknown as string)).toEqual([]);
  });
});

describe("protectedFrontmatterChanges", () => {
  it("flags a changed protected field (e.g. author / slug / packageUrl)", () => {
    const before = mdx({ title: "T", slug: "a", author: "Alice", packageUrl: "https://npmjs.com/x" });
    const after = mdx({ title: "T", slug: "a", author: "Eve", packageUrl: "https://npmjs.com/x" });
    expect(protectedFrontmatterChanges(before, after)).toEqual(["author"]);
  });

  it("does NOT flag an edit to an unprotected reference URL (those rot + need fixing)", () => {
    const before = mdx({ title: "T", slug: "a", githubUrl: "https://github.com/old/x" });
    const after = mdx({ title: "T", slug: "a", githubUrl: "https://github.com/new/x" });
    expect(protectedFrontmatterChanges(before, after)).toEqual([]);
  });

  it("is scalar-style insensitive (quoted vs unquoted same value → no change)", () => {
    const before = mdx({ title: "T", slug: "a", author: '"Alice"' });
    const after = mdx({ title: "T", slug: "a", author: "Alice" });
    expect(protectedFrontmatterChanges(before, after)).toEqual([]);
  });
});

describe("extractContentDuplicateSignals + strict match", () => {
  const candidate = extractContentDuplicateSignals({
    filePath: "content/skills/foo.mdx",
    content: mdx({ title: "Foo", slug: "foo", description: "A great skill", githubUrl: "https://github.com/acme/foo" }),
  });

  it("derives normalized signals (urls collapsed to repo root, www stripped, https forced)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/bar.mdx",
      content: mdx({ title: "Bar", slug: "bar", githubUrl: "http://www.github.com/Acme/Bar/tree/main" }),
    });
    expect(sig.category).toBe("tools");
    expect(sig.urls).toContain("https://github.com/acme/bar");
  });

  it("STRICT-matches on same content path", () => {
    const m = findStrictContentDuplicateMatch(candidate, [candidate]);
    expect(m).not.toBeNull();
    expect(m?.reasons.some((r) => r.includes("same content path"))).toBe(true);
  });

  it("STRICT-matches on same category + same slug", () => {
    const existing = extractContentDuplicateSignals({
      filePath: "content/skills/other.mdx",
      content: mdx({ title: "Other", slug: "foo", description: "different" }),
    });
    const m = findStrictContentDuplicateMatch(candidate, [existing]);
    expect(m?.reasons.some((r) => r.includes("same skills slug"))).toBe(true);
  });

  it("does NOT strict-match on a mere shared generic ecosystem domain", () => {
    const existing = extractContentDuplicateSignals({
      filePath: "content/skills/other.mdx",
      content: mdx({ title: "Other", slug: "other", description: "totally different", githubUrl: "https://github.com/other/thing" }),
    });
    expect(findStrictContentDuplicateMatch(candidate, [existing])).toBeNull();
  });

  it("STRICT-matches on shared blocking URL + same normalized description (same category)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "A", slug: "a", description: "Identical purpose text", websiteUrl: "https://acme.example/app" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "B", slug: "b", description: "Identical purpose text", websiteUrl: "https://acme.example/app" }),
    });
    const m = findStrictContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("same normalized description"))).toBe(true);
  });
});

describe("normalizeUrl — RFC 3986 percent-encoding canonicalization for duplicate detection", () => {
  const urlOf = (websiteUrl: string) =>
    extractContentDuplicateSignals({ filePath: "content/skills/x.mdx", content: mdx({ title: "X", slug: "x", websiteUrl }) }).urls[0];

  it("decodes percent-encoded unreserved characters (RFC 3986 §2.3)", () => {
    expect(urlOf("https://acme.example/%7Euser")).toBe(urlOf("https://acme.example/~user"));
    expect(urlOf("https://acme.example/%41BC")).toBe(urlOf("https://acme.example/ABC"));
    expect(urlOf("https://acme.example/~user")).toBe("https://acme.example/~user");
  });

  it("uppercases the hex of a reserved percent-triplet without decoding it (RFC 3986 §2.1)", () => {
    expect(urlOf("https://acme.example/a%2fb")).toBe(urlOf("https://acme.example/a%2Fb"));
    // …but an encoded reserved char is NOT the literal char — a genuinely different path must not be conflated.
    expect(urlOf("https://acme.example/a%2Fb")).not.toBe(urlOf("https://acme.example/a/b"));
  });

  it("leaves the query untouched and does not over-match a genuinely different URL", () => {
    // Percent-encoding normalization must not disturb the query or conflate distinct paths.
    expect(urlOf("https://acme.example/p?utm_source=z&a=1")).toBe(urlOf("https://acme.example/p?a=1")); // tracking strip unchanged
    expect(urlOf("https://acme.example/p")).not.toBe(urlOf("https://acme.example/q"));
    expect(urlOf("https://acme.example/p?b=2&a=1")).not.toBe(urlOf("https://acme.example/p?a=1&b=2")); // query order preserved
  });

  it("collapses two submissions that differ only by path percent-encoding into a STRICT duplicate", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "A", slug: "a", description: "Identical purpose text", websiteUrl: "https://acme.example/docs/%7Eguide" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "B", slug: "b", description: "Identical purpose text", websiteUrl: "https://acme.example/docs/~guide" }),
    });
    const m = findStrictContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("same canonical source URL"))).toBe(true);
  });
});

describe("buildContentDuplicateReview", () => {
  it("returns legacy / strict / related buckets", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/skills/foo.mdx",
      content: mdx({ title: "Foo", slug: "foo" }),
    });
    const review = buildContentDuplicateReview(sig, [sig]);
    expect(review.strictDuplicate).not.toBeNull();
    expect(review).toHaveProperty("legacyDuplicate");
    expect(review).toHaveProperty("relatedCandidates");
  });
});

describe("directoryIndexToSignals", () => {
  it("synthesizes corpus signals from directory-index entries, dropping the candidate's own path", () => {
    const entries = [
      { category: "skills", slug: "foo", title: "Foo", description: "d", githubUrl: "https://github.com/acme/foo" },
      { category: "skills", slug: "bar", title: "Bar", description: "d2" },
      { title: "no category" }, // dropped
    ];
    const signals = directoryIndexToSignals(entries, { currentFilePath: "content/skills/foo.mdx" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.slug).toBe("bar");
  });

  it("uses canonicalUrl when present, else falls back to `${siteUrl}/entry/...`", () => {
    const signals = directoryIndexToSignals(
      [
        // a URL signal field (githubUrl) on a NON-dropped entry exercises the per-field push (line 590)
        { category: "skills", slug: "withurl", title: "A", canonicalUrl: "https://example.com/a", githubUrl: "https://github.com/acme/withurl" },
        { category: "skills", slug: "nourl", title: "B" },
      ],
      { siteUrl: "https://site.example" },
    );
    const withUrl = signals.find((s) => s.slug === "withurl");
    expect(withUrl?.url).toBe("https://example.com/a");
    expect(withUrl?.urls).toContain("https://github.com/acme/withurl"); // the synthesized githubUrl signal flowed through
    expect(signals.find((s) => s.slug === "nourl")?.url).toBe("https://site.example/entry/skills/nourl");
  });

  it("returns [] when entries is not an array", () => {
    // The Array.isArray guard branch — a malformed (non-array) payload yields no signals.
    expect(directoryIndexToSignals(null as unknown as [])).toEqual([]);
  });
});

describe("findDuplicateFrontmatterKeys — block-scalar + sequence skipping", () => {
  it("skips a block-literal value's indented body without false-flagging its lines as keys", () => {
    const src = [
      "---",
      "description: |",
      "  title: not-a-real-key",
      "  another: line",
      "title: Real",
      "title: DupReal",
      "---",
      "",
      "body",
    ].join("\n");
    // The indented `title:`/`another:` inside the block literal must be skipped (lines 193-194);
    // only the two real top-level `title` keys count as the duplicate.
    expect(findDuplicateFrontmatterKeys(src)).toEqual(["title"]);
  });

  it("skips a sequence value's indented items (lines 195-196) and still catches a real dupe", () => {
    const src = ["---", "tags:", "  - a", "  - b", "category: x", "category: y", "---", "", "body"].join("\n");
    expect(findDuplicateFrontmatterKeys(src)).toEqual(["category"]);
  });

  it("returns [] when there is no frontmatter block", () => {
    expect(findDuplicateFrontmatterKeys("no frontmatter")).toEqual([]);
  });

  it("skips non-key lines (blank / comment) inside the block (lines 185-186)", () => {
    const src = ["---", "", "# comment line", "title: A", "slug: a", "---", "", "body"].join("\n");
    // The blank + comment lines fail the key regex → the `if (!head) continue` branch runs; no dupes.
    expect(findDuplicateFrontmatterKeys(src)).toEqual([]);
  });
});

describe("normalizeUrl edge cases (via extractContentDuplicateSignals)", () => {
  it("strips tracking/affiliate query params from a candidate URL (lines 243-251)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/x.mdx",
      content: mdx({ title: "X", slug: "x", websiteUrl: "https://app.example/x?utm_source=q&ref=abc&keep=1" }),
    });
    expect(sig.urls).toContain("https://app.example/x?keep=1");
  });

  it("preserves a distinct catalog SUBPATH for a multi-entry-catalog repo (lines 259-260)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/skills/x.mdx",
      content: mdx({ title: "X", slug: "x", githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git" }),
    });
    expect(sig.urls.some((u) => u.startsWith("https://github.com/modelcontextprotocol/servers/"))).toBe(true);
  });

  it("drops a non-http(s) URL field (returns '' → filtered out)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/x.mdx",
      content: mdx({ title: "X", slug: "x", websiteUrl: "ftp://files.example/x" }),
    });
    expect(sig.urls).toEqual([]);
  });

  it("drops an empty URL field value (line 236 early return) and a malformed one (line 269 catch)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/x.mdx",
      // empty websiteUrl → normalizeUrl raw "" early-returns; githubUrl ":::" → new URL throws → catch returns ""
      content: mdx({ title: "X", slug: "x", websiteUrl: '""', githubUrl: '":::"' }),
    });
    expect(sig.urls).toEqual([]);
  });
});

describe("findContentDuplicateMatch (legacy / advisory classifier)", () => {
  it("reports a shared canonical source URL (line 381)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Alpha", slug: "a", websiteUrl: "https://shared.example/app" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/tools/b.mdx",
      content: mdx({ title: "Beta", slug: "b", websiteUrl: "https://shared.example/app" }),
    });
    const m = findContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("same canonical source URL"))).toBe(true);
  });

  it("reports same normalized description in a category (line 399)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Alpha", slug: "a", description: "Exactly the same blurb" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "Beta", slug: "b", description: "Exactly the same blurb" }),
    });
    const m = findContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("same normalized description"))).toBe(true);
  });

  it("reports same domain + title (line 404) and a non-generic same-category domain (line 408)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "SameTitle", slug: "a", websiteUrl: "https://brand.example/one" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "SameTitle", slug: "b", websiteUrl: "https://brand.example/two" }),
    });
    const m = findContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("same source domain") && r.includes("and title"))).toBe(true);
    expect(m?.reasons.some((r) => r.includes("same non-generic source domain"))).toBe(true);
  });

  it("returns null when no existing item matches at all (line 413)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Unique A", slug: "a", websiteUrl: "https://one.example/x" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/tools/b.mdx",
      content: mdx({ title: "Unique B", slug: "b", websiteUrl: "https://two.example/y" }),
    });
    expect(findContentDuplicateMatch(a, [b])).toBeNull();
  });
});

describe("findStrictContentDuplicateMatch — catalog subpath + collections", () => {
  it("strict-matches a shared multi-entry-catalog SUBPATH in the same category (line 443)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "A", slug: "a", githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "B", slug: "b", githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git" }),
    });
    const m = findStrictContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("multi-entry catalog subpath URL"))).toBe(true);
  });

  it("does NOT strict-match a shared catalog ROOT alone (only a subpath blocks)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "A", slug: "a", githubUrl: "https://github.com/modelcontextprotocol/servers" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "B", slug: "b", githubUrl: "https://github.com/modelcontextprotocol/servers" }),
    });
    expect(findStrictContentDuplicateMatch(a, [b])).toBeNull();
  });

  it("strict-matches ≥2 shared blocking URLs between two collections (line 455)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/collections/a.mdx",
      content: mdx({ title: "Col A", slug: "a", websiteUrl: "https://one.example/x", docsUrl: "https://two.example/y" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/collections/b.mdx",
      content: mdx({ title: "Col B", slug: "b", websiteUrl: "https://one.example/x", docsUrl: "https://two.example/y" }),
    });
    const m = findStrictContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("same collection source set"))).toBe(true);
  });
});

describe("findRelatedContentMatches (non-blocking advisory)", () => {
  it("skips the candidate's own file path (line 476)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/skills/self.mdx",
      content: mdx({ title: "Self", slug: "self", websiteUrl: "https://x.example/a" }),
    });
    expect(findRelatedContentMatches(sig, [sig])).toEqual([]);
  });

  it("reports a shared canonical URL across DIFFERENT categories (lines 479-483)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "A", slug: "a", websiteUrl: "https://x.example/app" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/tools/b.mdx",
      content: mdx({ title: "B", slug: "b", websiteUrl: "https://x.example/app" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("across skills/tools"))).toBe(true);
  });

  it("uses the collection/resource phrasing when one side is the collections category (line 482)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/collections/a.mdx",
      content: mdx({ title: "A", slug: "a", websiteUrl: "https://x.example/app" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "B", slug: "b", websiteUrl: "https://x.example/app" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("across collection/resource categories"))).toBe(true);
  });

  it("reports a shared canonical URL within the SAME category (not-strict) (lines 485-488)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Distinct A", slug: "a", websiteUrl: "https://x.example/app" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "Distinct B", slug: "b", websiteUrl: "https://x.example/app" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("not a strict duplicate without the same title"))).toBe(true);
  });

  it("reports a shared multi-entry catalog ROOT in the same category (lines 490-492)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Distinct A", slug: "a", githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "Distinct B", slug: "b", githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/time" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("same multi-entry catalog source URL"))).toBe(true);
  });

  it("reports a shared non-generic domain in the SAME category (lines 495-499 same branch)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Distinct A", slug: "a", websiteUrl: "https://brand.example/one" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "Distinct B", slug: "b", websiteUrl: "https://brand.example/two" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("same non-generic source domain") && r.includes("in skills"))).toBe(true);
  });

  it("reports a shared non-generic domain ACROSS categories (line 501 branch)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Distinct A", slug: "a", websiteUrl: "https://brand.example/one" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/tools/b.mdx",
      content: mdx({ title: "Distinct B", slug: "b", websiteUrl: "https://brand.example/two" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("same non-generic source domain") && r.includes("across skills/tools"))).toBe(true);
  });

  it("reports same normalized title (not-strict) (lines 505-513)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Shared Title", slug: "a" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "Shared Title", slug: "b" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("same normalized title") && r.includes("not a strict duplicate"))).toBe(true);
  });

  it("reports same normalized description in a category (lines 516-522)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Aye", slug: "a", description: "Identical description body" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "Bee", slug: "b", description: "Identical description body" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("same normalized description in skills"))).toBe(true);
  });

  it("respects the limit, stopping after `limit` matches (lines 525-527)", () => {
    const candidate = extractContentDuplicateSignals({
      filePath: "content/skills/cand.mdx",
      content: mdx({ title: "Shared Title", slug: "cand" }),
    });
    const existing = Array.from({ length: 5 }, (_, n) =>
      extractContentDuplicateSignals({
        filePath: `content/skills/e${n}.mdx`,
        content: mdx({ title: "Shared Title", slug: `e${n}` }),
      }),
    );
    const m = findRelatedContentMatches(candidate, existing, 2);
    expect(m).toHaveLength(2); // capped at the limit even though all 5 would match
  });

  it("uses the DEFAULT limit (5) when none is passed (default-param branch)", () => {
    const candidate = extractContentDuplicateSignals({
      filePath: "content/skills/cand.mdx",
      content: mdx({ title: "Shared Title", slug: "cand" }),
    });
    const existing = Array.from({ length: 8 }, (_, n) =>
      extractContentDuplicateSignals({
        filePath: `content/skills/e${n}.mdx`,
        content: mdx({ title: "Shared Title", slug: `e${n}` }),
      }),
    );
    // No 3rd arg → `limit = 5` default applies, capping the 8 would-be matches at 5.
    expect(findRelatedContentMatches(candidate, existing)).toHaveLength(5);
  });

  it("returns [] when nothing relates at all (loop completes with no push)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Wholly Unique A", slug: "a", websiteUrl: "https://one.example/x" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/tools/b.mdx",
      content: mdx({ title: "Wholly Unique B", slug: "b", websiteUrl: "https://two.example/y" }),
    });
    expect(findRelatedContentMatches(a, [b])).toEqual([]);
  });

  it("uses the existing-side collections phrasing when EXISTING (not candidate) is collections (|| right side)", () => {
    // isCollectionBridge's `existing.category === "collections"` operand: candidate is a resource
    // category, existing is collections → still bridges to the collection/resource phrasing.
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "A", slug: "a", websiteUrl: "https://x.example/app" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/collections/b.mdx",
      content: mdx({ title: "B", slug: "b", websiteUrl: "https://x.example/app" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons[0]).toContain("across collection/resource categories");
  });

  it("reports a shared catalog ROOT matched by exact equality (multiEntryCatalogRoot `url === catalogUrl`)", () => {
    // Both URLs ARE the catalog root itself (not a subpath), exercising the `===` operand of the
    // `url === catalogUrl || url.startsWith(...)` disjunction in multiEntryCatalogRoot.
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/a.mdx",
      content: mdx({ title: "Distinct A", slug: "a", githubUrl: "https://github.com/modelcontextprotocol/servers" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/b.mdx",
      content: mdx({ title: "Distinct B", slug: "b", githubUrl: "https://github.com/modelcontextprotocol/servers" }),
    });
    const m = findRelatedContentMatches(a, [b]);
    expect(m[0]?.reasons.some((r) => r.includes("same multi-entry catalog source URL"))).toBe(true);
  });
});

describe("unquoteYamlScalar branches (via parseSimpleFrontmatter)", () => {
  it("strips a single-quoted scalar (the `'…'` operand of the quote check)", () => {
    const f = parseSimpleFrontmatter("---\ntitle: 'Quoted Single'\n---\n");
    expect(f.title).toBe("Quoted Single");
  });

  it("strips a trailing ` # comment` from an unquoted inline scalar (the else/replace branch)", () => {
    const f = parseSimpleFrontmatter("---\ntitle: Real Value  # trailing note\nslug: a\n---\n");
    expect(f.title).toBe("Real Value");
  });
});

describe("parseSimpleFrontmatter — falsy source guard", () => {
  it("returns {} for an empty string (String(source || '') → no match)", () => {
    expect(parseSimpleFrontmatter("")).toEqual({});
  });

  it("returns {} for a null source coerced via `source || ''` (defensive coercion)", () => {
    expect(parseSimpleFrontmatter(null as unknown as string)).toEqual({});
  });
});

describe("protectedFrontmatterChanges — absent-vs-present operand", () => {
  it("flags a protected field that was ABSENT before and ADDED after (normalizeProtectedValue undefined → '')", () => {
    const before = mdx({ title: "T", slug: "a" });
    const after = mdx({ title: "T", slug: "a", author: "Newly Added" });
    expect(protectedFrontmatterChanges(before, after)).toEqual(["author"]);
  });

  it("returns [] when every protected field is identically absent in both (the equal branch)", () => {
    const before = mdx({ title: "T", description: "x" });
    const after = mdx({ title: "T", description: "y" });
    // No protected field present on either side → all comparisons equal ('' === '') → no changes.
    expect(protectedFrontmatterChanges(before, after)).toEqual([]);
  });
});

describe("extractContentDuplicateSignals — category/slug fallback + apostrophe + missing fields", () => {
  it("falls back to PATH-derived category/slug when frontmatter omits them (|| right operand)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/agents/path-derived.mdx",
      content: mdx({ title: "P" }),
    });
    expect(sig.category).toBe("agents");
    expect(sig.slug).toBe("path-derived");
  });

  it("uses FRONTMATTER category/slug when present (|| left operand), normalizing the slug", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "weird/non-content-path.txt",
      content: mdx({ title: "P", category: "Tools", slug: "My Slug" }),
    });
    expect(sig.category).toBe("tools");
    expect(sig.slug).toBe("my-slug"); // normalizeText spaces → '-'
  });

  it("yields empty category/slug when neither path nor frontmatter supply them", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "weird/non-content-path.txt",
      content: mdx({ title: "P" }),
    });
    expect(sig.category).toBe("");
    expect(sig.slug).toBe("");
  });

  it("normalizes curly + straight apostrophes out of the title (the `['’]` replace branch)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/skills/x.mdx",
      content: mdx({ title: "Bob’s Don't Tool", slug: "x" }),
    });
    expect(sig.normalizedTitle).toBe("bobs dont tool");
  });

  it("defaults title/normalized fields to '' when title+description are absent (String(value||'') branch)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/skills/x.mdx",
      content: mdx({ slug: "x" }),
    });
    expect(sig.title).toBe("");
    expect(sig.normalizedTitle).toBe("");
    expect(sig.normalizedDescription).toBe("");
  });

  it("OMITS label/url keys entirely when not supplied (the conditional-spread false branch)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/skills/x.mdx",
      content: mdx({ title: "X", slug: "x" }),
    });
    expect("label" in sig).toBe(false);
    expect("url" in sig).toBe(false);
  });

  it("INCLUDES label/url keys when supplied (the conditional-spread true branch)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/skills/x.mdx",
      content: mdx({ title: "X", slug: "x" }),
      label: "lbl",
      url: "https://u.example",
    });
    expect(sig.label).toBe("lbl");
    expect(sig.url).toBe("https://u.example");
  });
});

describe("normalizeUrl — github.com path variants (via extractContentDuplicateSignals)", () => {
  it("returns the bare github root when there is NO owner/repo (the `owner && repo` false branch + pathname '|| /')", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/y.mdx",
      content: mdx({ title: "Y", slug: "y", githubUrl: "https://github.com" }),
    });
    // No owner/repo → skip the repoRoot return; pathname "/" → replace → "" → "|| '/'" → trailing slash stripped.
    expect(sig.urls).toEqual(["https://github.com"]);
  });

  it("keeps an owner-only github URL (owner present, repo undefined → `owner && repo` false)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/y.mdx",
      content: mdx({ title: "Y", slug: "y", githubUrl: "https://github.com/justowner" }),
    });
    expect(sig.urls).toEqual(["https://github.com/justowner"]);
  });

  it("collapses a non-catalog owner/repo to the lowercased repo root (the `owner && repo` true branch)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/g.mdx",
      content: mdx({ title: "G", slug: "g", githubUrl: "https://github.com/Acme/Repo/tree/main/sub" }),
    });
    expect(sig.urls).toEqual(["https://github.com/acme/repo"]);
  });

  it("strips a trailing `.git` from the repo segment", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/g.mdx",
      content: mdx({ title: "G", slug: "g", githubUrl: "https://github.com/Acme/Repo.git" }),
    });
    expect(sig.urls).toEqual(["https://github.com/acme/repo"]);
  });

  it("returns the catalog ROOT (no subpath) when a multi-entry-catalog repo has no remaining path (`rest.length` false)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/w.mdx",
      content: mdx({ title: "W", slug: "w", githubUrl: "https://github.com/modelcontextprotocol/servers" }),
    });
    // Catalog repo but rest is empty → the `MULTI_ENTRY_CATALOG_URLS.has(repoRoot) && rest.length`
    // conjunction is false → return repoRoot.
    expect(sig.urls).toEqual(["https://github.com/modelcontextprotocol/servers"]);
  });

  it("strips a trailing-slash-only path on a non-github host (the pathname `|| '/'` branch then trailing-slash trim)", () => {
    const sig = extractContentDuplicateSignals({
      filePath: "content/tools/z.mdx",
      content: mdx({ title: "Z", slug: "z", websiteUrl: "https://example.com/" }),
    });
    expect(sig.urls).toEqual(["https://example.com"]);
  });
});

describe("findContentDuplicateMatch — same-path and same-slug legacy reasons", () => {
  it("reports `same content path` when the candidate IS an existing item (line 372)", () => {
    const c = extractContentDuplicateSignals({
      filePath: "content/skills/dup.mdx",
      content: mdx({ title: "D", slug: "dup" }),
    });
    const m = findContentDuplicateMatch(c, [c]);
    expect(m?.reasons.some((r) => r.includes("same content path"))).toBe(true);
  });

  it("reports `same <category> slug` for a same-category same-slug pair on DIFFERENT paths (line 375)", () => {
    const a = extractContentDuplicateSignals({
      filePath: "content/skills/e1.mdx",
      content: mdx({ title: "E", slug: "sameslug" }),
    });
    const b = extractContentDuplicateSignals({
      filePath: "content/skills/e2.mdx",
      content: mdx({ title: "E Other", slug: "sameslug" }),
    });
    const m = findContentDuplicateMatch(a, [b]);
    expect(m?.reasons.some((r) => r.includes("same skills slug"))).toBe(true);
  });
});

describe("directoryIndexToSignals — array guard + empty-options defaults", () => {
  it("returns [] for an empty array (no entries to map)", () => {
    expect(directoryIndexToSignals([])).toEqual([]);
  });

  it("defaults siteUrl to '' and uses `${siteUrl}/entry/...` when canonicalUrl is missing (the ?? '' branch)", () => {
    const signals = directoryIndexToSignals([{ category: "skills", slug: "nourl", title: "N" }]);
    // No options passed → siteUrl defaults to '' → url falls back to "/entry/skills/nourl".
    expect(signals[0]?.url).toBe("/entry/skills/nourl");
  });

  it("drops entries missing a category OR a slug (the `!category || !slug` guard, both operands)", () => {
    const signals = directoryIndexToSignals([
      { slug: "only-slug", title: "no category" },
      { category: "skills", title: "no slug" },
      { category: "skills", slug: "kept", title: "kept" },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.slug).toBe("kept");
  });

  it("does NOT exclude any path when currentFilePath is undefined (the filePath !== undefined keeps all)", () => {
    const signals = directoryIndexToSignals([
      { category: "skills", slug: "a", title: "A" },
      { category: "skills", slug: "b", title: "B" },
    ]);
    expect(signals.map((s) => s.slug).sort()).toEqual(["a", "b"]);
  });
});

describe("per-repo ContentRepoSpec override (a self-hosted curated list re-parameterizes dedup)", () => {
  it("protectedFrontmatterChanges honors a custom protected-field set instead of the default", () => {
    const before = mdx({ author: "A", customField: "x" });
    const after = mdx({ author: "B", customField: "y" });
    expect(protectedFrontmatterChanges(before, after)).toEqual(["author"]); // default: author protected, customField not
    const spec = customSpec({ protectedFrontmatterFields: new Set(["customField"]) });
    expect(protectedFrontmatterChanges(before, after, spec)).toEqual(["customField"]); // custom: only customField protected
  });

  it("extractContentDuplicateSignals reads URLs from the custom url-field set", () => {
    const content = mdx({ title: "T", category: "tools", slug: "t", myLink: "https://example.com/a", githubUrl: "https://github.com/o/r" });
    const spec = customSpec({ urlFields: new Set(["myLink"]) });
    const signals = extractContentDuplicateSignals({ filePath: "content/tools/t.mdx", content }, spec);
    expect(signals.urls).toEqual(["https://example.com/a"]); // githubUrl ignored — not in the custom url-field set
  });

  it("a custom domain-exclusion set changes related-domain matching (threaded through the find functions)", () => {
    const entry = (slug: string, title: string) =>
      extractContentDuplicateSignals({
        filePath: `content/tools/${slug}.mdx`,
        content: mdx({ title, category: "tools", slug, githubUrl: `https://github.com/org/${slug}` }),
      });
    const a = entry("alpha", "Alpha");
    const b = entry("beta", "Beta");
    expect(findRelatedContentMatches(a, [b])).toEqual([]); // default: github.com is a generic excluded host
    const spec = customSpec({ domainOnlyExclusions: new Set() });
    const related = findRelatedContentMatches(a, [b], 5, spec); // custom: github.com no longer excluded
    expect(related.map((m) => m.reasons.some((r) => r.includes("github.com")))).toEqual([true]);
  });

  it("buildContentDuplicateReview threads the spec into the find functions", () => {
    const make = (slug: string, title: string) =>
      extractContentDuplicateSignals({ filePath: `content/tools/${slug}.mdx`, content: mdx({ title, category: "tools", slug, githubUrl: `https://github.com/org/${slug}` }) });
    const a = make("alpha", "Alpha");
    const b = make("beta", "Beta");
    expect(buildContentDuplicateReview(a, [b]).relatedCandidates).toEqual([]); // default: github.com is excluded
    const spec = customSpec({ domainOnlyExclusions: new Set() });
    expect(buildContentDuplicateReview(a, [b], spec).relatedCandidates).toHaveLength(1); // custom: shared domain surfaces
  });

  it("directoryIndexToSignals threads the spec into corpus extraction", () => {
    const entries = [{ category: "tools", slug: "x", title: "X", githubUrl: "https://github.com/o/r" }];
    expect(directoryIndexToSignals(entries)[0]?.urls).toEqual(["https://github.com/o/r"]); // default url fields read githubUrl
    expect(directoryIndexToSignals(entries, {}, customSpec({ urlFields: new Set() }))[0]?.urls).toEqual([]); // custom empty set → none
  });
});
