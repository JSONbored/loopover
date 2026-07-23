import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// REGRESSION: docs-source.ts (now docs-source.server.ts) imports fumadocs-mdx's generated
// `collections/server` module, which globs every content/docs/*.mdx file eagerly and depends
// on Node's `path` module. Every docs.*.tsx route's loader used to import it directly --
// TanStack Router route loaders run in the browser on client-side navigations, not just on
// the server, so any in-app click into a docs page (not a hard reload) crashed with
// "path.join is not a function" and rendered the router's error boundary. Fixed by moving the
// fumadocs-mdx lookup behind a createServerFn (docs-source.functions.ts) so the client always
// fetches the result over the wire instead of re-executing the server-only module itself.
//
// docs-source.server.ts isn't imported here: like docs.miner-coding-agent.test.tsx and
// docs.ams-observability-callout.test.tsx, actually evaluating fumadocs-mdx's generated
// `collections/server` module needs the fumadocs-mdx Vite plugin (registered for the app build,
// not this standalone vitest.config.ts), so this is a source-level drift guard instead.

describe("docs.*.tsx routes never import docs-source(.server) directly", () => {
  const routesDir = join(process.cwd(), "src/routes");
  const outOfScope = new Set([
    "docs.fumadocs-spike-api-reference.tsx",
    "docs.index.tsx",
    "docs.tsx",
  ]);
  const docsRouteFiles = readdirSync(routesDir).filter(
    (name) => name.startsWith("docs.") && name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
  );
  const inScope = docsRouteFiles.filter((name) => !outOfScope.has(name));

  it("found the expected set of in-scope docs route files", () => {
    expect(inScope.length).toBe(49);
  });

  it.each(inScope)(
    "%s: loads doc metadata via getDocPage, not docs-source.server directly",
    (file) => {
      const source = readFileSync(join(routesDir, file), "utf8");
      expect(source, `${file} should import getDocPage from docs-source.functions`).toContain(
        'import { getDocPage } from "@/lib/docs-source.functions";',
      );
      expect(
        source,
        `${file} must not import docs-source(.server) directly -- it would ship the ` +
          "Node-only fumadocs-mdx lookup into the client bundle and crash on SPA navigation",
      ).not.toMatch(/from ["']@\/lib\/docs-source(\.server)?["']/);
    },
  );
});
