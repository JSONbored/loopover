import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("raycast package boundaries", () => {
  it("documents auth-only storage and forbids PAT persistence in README", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    expect(readme).toMatch(/gts_.*session token/i);
    expect(readme).toMatch(/GitHub Device Flow/i);
    expect(readme).toMatch(/does \*\*not\*\*:[\s\S]*personal access tokens/i);
  });

  it("keeps lib modules free of source-upload API paths", () => {
    const libFiles = ["auth.ts", "api.ts", "storage.ts", "config.ts"].map((file) => readFileSync(join(packageRoot, "lib", file), "utf8"));
    const combined = libFiles.join("\n");
    expect(combined).not.toMatch(/\/v1\/.*upload|source\/contents|uploadSource/i);
    expect(combined).toMatch(/\/v1\/auth\//);
  });

  it("package manifest exposes only auth commands", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { commands: Array<{ name: string }> };
    expect(manifest.commands.map((command) => command.name).sort()).toEqual(["login", "logout", "status"]);
  });
});
