import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// REGRESSION (#9521): a package whose build is `tsc -p` with `incremental` (inherited from the root
// tsconfig) decides what to emit from `.tsbuildinfo` ALONE — it never checks whether the outputs it
// describes are still on disk. turbo caches `.tsbuildinfo` alongside `dist/`, so any run where the two come
// back out of lockstep (or a `--force` run over a leftover stamp) makes tsc declare itself up to date and
// emit NOTHING, leaving `dist/` without the new files.
//
// That is not hypothetical: adding four modules to @loopover/contract produced a green
// `@loopover/contract:build` in CI followed immediately by
// `Cannot find module '@loopover/contract/local-config'` from the miner's own build, on the same runner,
// five seconds apart. Every package that caches `.tsbuildinfo` as a turbo output has the same exposure, so
// each of them deletes the stamp before building.

const PACKAGES_CACHING_TSBUILDINFO = ["loopover-contract", "loopover-mcp", "loopover-miner"] as const;

function buildScript(pkg: string): string {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), `packages/${pkg}/package.json`), "utf8")) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts["build:tsc"] ?? manifest.scripts.build!;
}

describe("tsc packages cannot no-op their own emit (#9521)", () => {
  it.each(PACKAGES_CACHING_TSBUILDINFO)("%s clears .tsbuildinfo before compiling", (pkg) => {
    const script = buildScript(pkg);
    expect(script, `${pkg}'s build must not trust a stale incremental stamp`).toContain(".tsbuildinfo");
    // The clear must come FIRST — after tsc it would defeat the purpose entirely.
    expect(script.indexOf(".tsbuildinfo"), `${pkg} must clear the stamp before tsc runs`).toBeLessThan(script.indexOf("tsc -p"));
  });

  it("names every package that caches .tsbuildinfo as a turbo output — a new one must be added here", () => {
    const turbo = readFileSync(join(process.cwd(), "turbo.json"), "utf8");
    // Strip comments; turbo.json is JSONC and the comments themselves mention .tsbuildinfo.
    const withoutComments = turbo.replace(/^\s*\/\/.*$/gm, "");
    const tasks = [...withoutComments.matchAll(/"(@loopover\/[a-z-]+)#build(?::tsc)?":\s*\{[^}]*?"outputs":\s*\[([^\]]*)\]/gs)];
    const caching = tasks.filter(([, , outputs]) => outputs!.includes(".tsbuildinfo")).map(([, name]) => name!.replace("@loopover/", "loopover-"));
    expect(caching.sort()).toEqual([...PACKAGES_CACHING_TSBUILDINFO].sort());
  });
});
