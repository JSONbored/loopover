import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// #8309: @loopover/ui-kit is a real, published npm package (publishConfig.access: "public") -- every
// component that wraps an external library must declare that library in its own package.json, since a
// consumer installing the package in isolation (or a workspace member that doesn't happen to hoist the
// dependency from elsewhere, e.g. loopover-miner-ui) has no other guarantee module resolution succeeds.
// This asserts every external import across the package's (non-test) components has a matching
// dependencies/peerDependencies entry, so a future component that forgets to declare its import is
// caught here instead of only failing for a consumer outside this monorepo's hoisting.

const COMPONENTS_DIR = join("packages", "loopover-ui-kit", "src", "components");

function packageNameFromSpecifier(specifier: string): string {
  const segments = specifier.split("/");
  // Scoped package (@scope/name) -- the package name is the first two path segments; everything else
  // (unscoped, e.g. "lucide-react", or a subpath import like "some-pkg/sub") is just the first segment.
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
}

function externalImportsIn(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /import\s[\s\S]*?from\s+["']([^"']+)["']/g,
  )) {
    const specifier = match[1];
    if (specifier && !specifier.startsWith("."))
      specifiers.push(packageNameFromSpecifier(specifier));
  }
  return specifiers;
}

describe("packages/loopover-ui-kit package.json declares every component's external imports (#8309)", () => {
  it("every non-test component's external import has a dependencies or peerDependencies entry", () => {
    const pkg = JSON.parse(
      readFileSync(join("packages", "loopover-ui-kit", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);

    const componentFiles = readdirSync(COMPONENTS_DIR).filter(
      (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
    );
    expect(componentFiles.length).toBeGreaterThan(0); // guard against a glob/path typo silently checking nothing

    const undeclared: string[] = [];
    for (const file of componentFiles) {
      const source = readFileSync(join(COMPONENTS_DIR, file), "utf8");
      for (const importedPackage of externalImportsIn(source)) {
        if (!declared.has(importedPackage))
          undeclared.push(`${file}: ${importedPackage}`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
