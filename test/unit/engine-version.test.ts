import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENGINE_VERSION } from "../../packages/gittensory-engine/src/version";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../packages/gittensory-engine/package.json");

describe("ENGINE_VERSION", () => {
  it("matches packages/gittensory-engine/package.json version", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(barrel.ENGINE_VERSION).toBe(ENGINE_VERSION);
    expect(barrel.ENGINE_VERSION.length).toBeGreaterThan(0);
  });
});
