import { describe, expect, it } from "vitest";
import {
  classifyContentFiles,
  importContentPathParts,
  SUPPORTED_CONTENT_CATEGORIES,
  touchesContentEntry,
} from "../../src/review/content-lane/scope";

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
