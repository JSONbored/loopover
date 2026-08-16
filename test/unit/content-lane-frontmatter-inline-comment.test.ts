import { describe, expect, it } from "vitest";
import { parseSimpleFrontmatter as parseDuplicateFrontmatter } from "../../src/review/content-lane/duplicates";
import { __sourceEvidenceInternals } from "../../src/review/content-lane/source-evidence";

const quotedWithComment = '---\ntitle: "My Skill" # published 2024\n---\n';

describe("content-lane frontmatter scalar comments", () => {
  it("removes an inline comment before unquoting in the duplicate parser", () => {
    expect(parseDuplicateFrontmatter(quotedWithComment).title).toBe("My Skill");
  });

  it("removes an inline comment before unquoting in the source-evidence parser", () => {
    expect(__sourceEvidenceInternals.parseSimpleFrontmatter(quotedWithComment).title).toBe("My Skill");
  });

  it("preserves existing scalar behavior in both parsers", () => {
    const parsers = [parseDuplicateFrontmatter, __sourceEvidenceInternals.parseSimpleFrontmatter];

    for (const parse of parsers) {
      expect(parse('---\ntitle: plain # note\n---\n').title).toBe("plain");
      expect(parse('---\ntitle: "quoted"\n---\n').title).toBe("quoted");
      expect(parse("---\ntitle: unadorned\n---\n").title).toBe("unadorned");
      expect(parse("---\ntitle: 'single quoted' # note\n---\n").title).toBe("single quoted");
    }
  });
});
