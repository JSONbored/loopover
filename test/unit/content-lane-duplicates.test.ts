import { describe, expect, it } from "vitest";
import {
  buildContentDuplicateReview,
  directoryIndexToSignals,
  extractContentDuplicateSignals,
  findDuplicateFrontmatterKeys,
  findStrictContentDuplicateMatch,
  parseSimpleFrontmatter,
  protectedFrontmatterChanges,
} from "../../src/review/content-lane/duplicates";

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
});

describe("findDuplicateFrontmatterKeys", () => {
  it("catches a repeated top-level key (would crash the gray-matter build)", () => {
    const src = "---\ntitle: A\nslug: a\ntitle: B\n---\n\nbody";
    expect(findDuplicateFrontmatterKeys(src)).toContain("title");
  });

  it("returns [] when keys are unique", () => {
    expect(findDuplicateFrontmatterKeys(mdx({ title: "A", slug: "a" }))).toEqual([]);
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
});
