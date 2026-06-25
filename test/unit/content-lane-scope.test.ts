import { describe, expect, it } from "vitest";
import {
  classifyContentFiles,
  importContentPathParts,
  SUPPORTED_CONTENT_CATEGORIES,
  touchesContentEntry,
} from "../../src/review/content-lane/scope";
import { AWESOME_CLAUDE_CONTENT_SPEC, type ContentRepoSpec } from "../../src/review/content-lane/content-repo-spec";

describe("importContentPathParts", () => {
  it("parses content/<cat>/<slug>.mdx, lowercasing category + slugifying slug", () => {
    expect(importContentPathParts("content/skills/My_Cool Skill.mdx")).toEqual({
      category: "skills",
      slug: "my-cool-skill",
    });
    expect(importContentPathParts("content/MCP/Server.mdx")).toEqual({ category: "mcp", slug: "server" });
  });

  it("returns null for non-content paths", () => {
    expect(importContentPathParts("README.md")).toBeNull();
    expect(importContentPathParts("content/skills/nested/file.mdx")).toBeNull();
    expect(importContentPathParts("src/index.ts")).toBeNull();
  });
});

describe("touchesContentEntry", () => {
  it("detects whether any path is a content entry", () => {
    expect(touchesContentEntry(["content/agents/foo.mdx"])).toBe(true);
    expect(touchesContentEntry(["README.md", "package.json"])).toBe(false);
  });
});

describe("classifyContentFiles", () => {
  it("ignores PRs with no content entry", () => {
    const r = classifyContentFiles([{ filename: "README.md", status: "modified" }]);
    expect(r.kind).toBe("ignore");
  });

  it("reviews a single added supported-category entry", () => {
    const r = classifyContentFiles([{ filename: "content/skills/foo.mdx", status: "added" }]);
    expect(r).toEqual({ kind: "review", category: "skills", slug: "foo", file: "content/skills/foo.mdx", status: "added" });
  });

  it("closes an unsupported category", () => {
    const r = classifyContentFiles([{ filename: "content/weird/foo.mdx", status: "added" }]);
    expect(r.kind).toBe("close");
    if (r.kind === "close") expect(r.reason).toContain("Unsupported content category");
  });

  it("treats a single removed entry as a deletion (maintainer cleanup)", () => {
    const r = classifyContentFiles([{ filename: "content/skills/foo.mdx", status: "removed" }]);
    expect(r).toEqual({ kind: "deletion", category: "skills", slug: "foo", file: "content/skills/foo.mdx" });
  });

  it("closes two+ content entries in one PR (one-file rule)", () => {
    const r = classifyContentFiles([
      { filename: "content/skills/a.mdx", status: "added" },
      { filename: "content/skills/b.mdx", status: "added" },
    ]);
    expect(r.kind).toBe("close");
    if (r.kind === "close") expect(r.category).toBe("skills");
  });

  it("closes a fork PR bundling extra files with one entry", () => {
    const r = classifyContentFiles(
      [
        { filename: "content/skills/a.mdx", status: "added" },
        { filename: "scripts/build.mjs", status: "modified" },
      ],
      { headRepo: "fork/x", baseRepo: "JSONbored/awesome-claude" },
    );
    expect(r.kind).toBe("close");
  });

  it("ignores a same-repo mixed maintenance PR (advisory, not close)", () => {
    const r = classifyContentFiles(
      [
        { filename: "content/skills/a.mdx", status: "modified" },
        { filename: "scripts/build.mjs", status: "modified" },
      ],
      { headRepo: "JSONbored/awesome-claude", baseRepo: "JSONbored/awesome-claude" },
    );
    expect(r.kind).toBe("ignore");
  });

  it("ignores a same-repo links/ maintenance branch editing many entries", () => {
    const r = classifyContentFiles(
      [
        { filename: "content/skills/a.mdx", status: "modified" },
        { filename: "content/skills/b.mdx", status: "modified" },
      ],
      { headRepo: "JSONbored/awesome-claude", baseRepo: "JSONbored/awesome-claude", headRef: "links/canonicalize" },
    );
    expect(r.kind).toBe("ignore");
  });

  it("ignores a same-repo multi-file deletion (maintainer cleanup)", () => {
    const r = classifyContentFiles(
      [
        { filename: "content/skills/a.mdx", status: "removed" },
        { filename: "content/skills/b.mdx", status: "removed" },
      ],
      { headRepo: "JSONbored/awesome-claude", baseRepo: "JSONbored/awesome-claude" },
    );
    expect(r.kind).toBe("ignore");
  });

  it("closes a bad status (renamed) single entry", () => {
    const r = classifyContentFiles([{ filename: "content/skills/foo.mdx", status: "renamed" }]);
    expect(r.kind).toBe("close");
  });

  it("exposes the supported categories set", () => {
    expect(SUPPORTED_CONTENT_CATEGORIES.has("skills")).toBe(true);
    expect(SUPPORTED_CONTENT_CATEGORIES.has("not-a-category")).toBe(false);
  });
});

describe("ContentRepoSpec (a self-hosted curated list parameterizes the lane)", () => {
  const custom: ContentRepoSpec = {
    categories: new Set(["recipes", "tutorials"]),
    entryPathPattern: /^entries\/([^/]+)\/([^/]+)\.md$/i,
    maintenanceBranchPrefixes: ["bot/"],
  };

  it("the default spec carries awesome-claude's categories + entry layout", () => {
    expect(AWESOME_CLAUDE_CONTENT_SPEC.categories.has("skills")).toBe(true);
    expect(SUPPORTED_CONTENT_CATEGORIES).toBe(AWESOME_CLAUDE_CONTENT_SPEC.categories);
  });

  it("importContentPathParts honours a custom entry pattern", () => {
    expect(importContentPathParts("entries/recipes/My Dish.md", custom)).toEqual({ category: "recipes", slug: "my-dish" });
    expect(importContentPathParts("content/skills/x.mdx", custom)).toBeNull(); // the awesome layout no longer matches
  });

  it("touchesContentEntry honours a custom entry pattern", () => {
    expect(touchesContentEntry(["entries/recipes/foo.md"], custom)).toBe(true);
    expect(touchesContentEntry(["content/agents/foo.mdx"], custom)).toBe(false);
  });

  it("classifyContentFiles reviews a custom category and closes an unsupported one", () => {
    expect(classifyContentFiles([{ filename: "entries/recipes/foo.md", status: "added" }], {}, custom)).toMatchObject({ kind: "review", category: "recipes" });
    expect(classifyContentFiles([{ filename: "entries/unknown/foo.md", status: "added" }], {}, custom)).toMatchObject({ kind: "close" });
    expect(classifyContentFiles([{ filename: "", status: "added" }], {}, custom)).toMatchObject({ kind: "ignore" }); // falsy filename → no entry
  });

  it("classifyContentFiles honours custom maintenance-branch prefixes", () => {
    const files = [
      { filename: "entries/recipes/a.md", status: "modified" },
      { filename: "entries/recipes/b.md", status: "modified" },
    ];
    const ctx = { headRepo: "me/list", baseRepo: "me/list", headRef: "bot/link-fix" };
    expect(classifyContentFiles(files, ctx, custom)).toMatchObject({ kind: "ignore" });
  });
});
