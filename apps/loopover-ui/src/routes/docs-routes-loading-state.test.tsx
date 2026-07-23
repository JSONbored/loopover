import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Suspense, use } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LoadingState } from "@/components/site/state-views";

// #6982: all 46 docs.*.tsx routes hand-rolled an identical plain-text `<p>Loading…</p>` Suspense
// fallback instead of the shared LoadingState primitive every other consumer in this app already uses
// (see changelog.tsx). Fixed by importing LoadingState and using `<Suspense fallback={<LoadingState />}>`
// everywhere, matching LoadingState's own accessible role="status" markup.

function NeverResolves(): never {
  // Mirrors fumadocs-mdx's real Renderer, which suspends via `use()` on a dynamic-import promise
  // (docs-client-loader.tsx) -- a promise that never settles keeps the Suspense boundary showing its
  // fallback indefinitely, the same as a slow/never-hydrating MDX chunk would in production.
  return use(new Promise<never>(() => {}));
}

describe("docs route Suspense fallback (#6982)", () => {
  it("LoadingState renders the accessible role=status markup every docs route's Suspense boundary now falls back to", () => {
    render(
      <Suspense fallback={<LoadingState />}>
        <NeverResolves />
      </Suspense>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("every docs.*.tsx route imports LoadingState and uses it as the sole Suspense fallback, not a hand-rolled <p>", () => {
    const routesDir = join(process.cwd(), "src/routes");
    const docsRouteFiles = readdirSync(routesDir).filter(
      (name) => name.startsWith("docs.") && name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
    );

    // fumadocs-spike-api-reference.tsx is a standalone Scalar API-reference spike (#6037) that wraps
    // ClientOnly, not Suspense; docs.index.tsx is a static landing page with no MDX content and no
    // Suspense boundary; docs.tsx is the shared parent layout route, not a content page. None were
    // part of this issue's 46-file scope.
    const outOfScope = new Set([
      "docs.fumadocs-spike-api-reference.tsx",
      "docs.index.tsx",
      "docs.tsx",
    ]);
    const inScope = docsRouteFiles.filter((name) => !outOfScope.has(name));
    expect(inScope.length).toBe(49);

    for (const file of inScope) {
      const source = readFileSync(join(routesDir, file), "utf8");
      expect(source, `${file} should import LoadingState`).toContain(
        'import { LoadingState } from "@/components/site/state-views";',
      );
      expect(source, `${file} should use LoadingState as the Suspense fallback`).toContain(
        "<Suspense fallback={<LoadingState />}>",
      );
      expect(
        source,
        `${file} should not still hand-roll the old plain-text fallback`,
      ).not.toContain('text-muted-foreground">Loading…</p>');
    }
  });
});
