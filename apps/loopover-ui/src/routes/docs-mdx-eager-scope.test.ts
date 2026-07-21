import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { docsMdxComponents } from "@/lib/docs-mdx-components";

// #7578: content/docs/maintainer-workflow.mdx pulled its <WorkflowMirror> `steps` prop out into a
// top-level `export const steps = [...]` ESM block containing `<CodeBlock>` JSX. fumadocs-mdx only
// auto-resolves capitalized JSX tags against the `components` prop (with a friendly "missing
// reference" guard) *inside* the markdown body, compiled into `_createMdxContent` -- a top-level
// `export const` runs eagerly at module-evaluation time, before any `components` prop exists, so an
// unimported provided-component name there is a bare, unresolved identifier: a raw ReferenceError,
// not fumadocs' friendly message.
//
// That alone would only break the one page. It broke every docs page because docs-source.ts (used by
// every docs.*.tsx route's server loader) imports fumadocs-mdx's generated collections/server module,
// which globs *all* content/docs/*.mdx files with `eager: true` -- so one file with this defect throws
// during module evaluation and takes down every docs route's SSR loader, not just its own page.
//
// Fixed by importing the component directly into the .mdx file (matching how
// MAINTAINER_COMMAND_LIST/PUBLIC_COMMAND_LIST are already imported there), which MDX honors as a
// normal JS binding instead of routing it through the components prop. This test guards the whole
// class: any content/docs/*.mdx file whose top-level `export const` block references a
// docsMdxComponents-provided tag it hasn't also imported directly would reproduce the same
// eager-module-evaluation crash for every docs page.

const DOCS_DIR = join(process.cwd(), "content/docs");

// `a` is an intrinsic-element override (lowercase), not a capitalized custom component -- irrelevant
// to this bug class, which only concerns capitalized JSX tags resolved via the provided `components`
// prop (fumadocs never routes lowercase/intrinsic tags through it).
const PROVIDED_COMPONENT_NAMES = Object.keys(docsMdxComponents).filter((name) =>
  /^[A-Z]/.test(name),
);

/** Every top-level `export const NAME = ...` block, from its `export const` line through the `];`/`};` that closes it at column 0. */
function extractTopLevelExportConstBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of source.split("\n")) {
    if (!current && /^export const \w+ = /.test(line)) {
      current = [line];
      continue;
    }
    if (current) {
      current.push(line);
      if (/^(\];|\};)/.test(line)) {
        blocks.push(current.join("\n"));
        current = null;
      }
    }
  }
  return blocks;
}

/** Local binding names introduced by this file's own `import { ... } from "...";` statements (aliases resolved to their local name). */
function extractImportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*["'][^"']+["'];?\s*$/gm)) {
    for (const raw of match[1].split(",")) {
      const localName = raw
        .trim()
        .split(/\s+as\s+/i)
        .pop()
        ?.trim();
      if (localName) names.add(localName);
    }
  }
  return names;
}

describe("docs .mdx top-level export const blocks don't reference provided-only components (#7578)", () => {
  const mdxFiles = readdirSync(DOCS_DIR).filter((name) => name.endsWith(".mdx"));

  it("found docs content files to scan (sanity check the scan itself isn't silently a no-op)", () => {
    expect(mdxFiles.length).toBeGreaterThan(0);
  });

  it.each(mdxFiles)(
    "%s: components used in a top-level export const are directly imported, not left to the components prop",
    (file) => {
      const source = readFileSync(join(DOCS_DIR, file), "utf8");
      const importedNames = extractImportedNames(source);

      for (const block of extractTopLevelExportConstBlocks(source)) {
        for (const [, tagName] of block.matchAll(/<([A-Z]\w*)/g)) {
          const isProvidedOnly =
            PROVIDED_COMPONENT_NAMES.includes(tagName) && !importedNames.has(tagName);
          expect(
            isProvidedOnly,
            `${file}: top-level export const references <${tagName}>, which is only supplied via the MDX ` +
              `components prop and unresolved at eager module-evaluation time. Import it directly, e.g. ` +
              `import { ${tagName} } from "@/components/site/primitives";`,
          ).toBe(false);
        }
      }
    },
  );
});
