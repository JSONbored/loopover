import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { docsNav } from "./docs-nav";

// REGRESSION (#8385): docsNav drives both the persistent /docs/* left rail and DocsPrevNext's
// prev/next footer links, but it was maintained entirely by hand alongside docs.index.tsx's own
// curated card list. Six published, cross-linked pages (miner-quickstart, loopover-commands,
// ai-summaries, owner-checklist, self-hosting-docs-audit, self-hosting-unified-ams-orb) had real
// content/docs/*.mdx files and index-page links but no sidebar entry, so a visitor landing on one
// saw an unhighlighted rail with no route to any other group, and no page's prev/next ever reached
// them. This is the drift guard: content/docs/ is the source of truth for what's published, so a new
// .mdx that forgets its docsNav entry fails here instead of silently shipping unreachable.
//
// Filesystem-reading in a vitest test follows docs-source-server-isolation.test.ts's precedent --
// process.cwd() is apps/loopover-ui because this file is only matched by that workspace's own
// vitest.config.ts (`include: ["src/**/*.test.{ts,tsx}"]`); the root config takes `test/**` only.
describe("docsNav covers every published docs page (#8385)", () => {
  const contentDir = join(process.cwd(), "content/docs");
  const publishedSlugs = readdirSync(contentDir)
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => name.slice(0, -".mdx".length))
    .sort();

  const navPaths = docsNav.flatMap((group) =>
    "items" in group
      ? group.items.map((item) => item.to)
      : group.subgroups.flatMap((sub) => sub.items.map((item) => item.to)),
  );

  it("reads a non-empty content/docs directory (guards against a silently-vacuous assertion)", () => {
    expect(publishedSlugs.length).toBeGreaterThan(40);
  });

  it("has a sidebar entry for every published .mdx page", () => {
    const missing = publishedSlugs.filter((slug) => !navPaths.includes(`/docs/${slug}`));
    expect(missing).toEqual([]);
  });

  it("has no sidebar entry pointing at a page that isn't published", () => {
    // "/docs" is the index route itself (docs.index.tsx), not a content/docs/*.mdx page.
    const dangling = navPaths
      .filter((to) => to !== "/docs")
      .filter((to) => !publishedSlugs.includes(to.replace("/docs/", "")));
    expect(dangling).toEqual([]);
  });

  it("lists every page exactly once, so prev/next can't revisit a page", () => {
    const duplicates = navPaths.filter((to, index) => navPaths.indexOf(to) !== index);
    expect(duplicates).toEqual([]);
  });
});
