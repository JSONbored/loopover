import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeLocalManifestReader } from "../../src/selfhost/private-config";
import { parseFocusManifestContent } from "../../src/signals/focus-manifest";

// The shipped self-host private-config examples (config/examples/*.gittensory.yml, referenced by
// config/examples/README.md) must stay valid, comment-tolerant YAML that the SAME parser the real
// private-config reader uses accepts cleanly — a stale/broken example would silently mislead every
// self-host operator who copies it. Pure structural checks only (no docker/CLI invocation, mirroring
// the selfhost-compose-*.test.ts convention for other shipped self-host artifacts).

function readExample(name: string): string {
  return readFileSync(join("config/examples", name), "utf8");
}

describe("config/examples/global.gittensory.yml", () => {
  it("parses cleanly with no warnings and sets the documented fields", () => {
    const manifest = parseFocusManifestContent(readExample("global.gittensory.yml"));
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    expect(manifest.gate.enabled).toBe(true);
    expect(manifest.gate.duplicates).toBe("block");
    expect(manifest.settings.contributorOpenPrCap).toBe(3);
    expect(manifest.settings.autoCloseExemptLogins).toEqual(["your-admin-login"]);
  });
});

describe("config/examples/repo-override.gittensory.yml", () => {
  it("parses cleanly with no warnings and sets the documented fields", () => {
    const manifest = parseFocusManifestContent(readExample("repo-override.gittensory.yml"));
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    expect(manifest.gate.enabled).toBe(true);
    expect(manifest.wantedPaths).toEqual(["src/**"]);
    expect(manifest.settings.contributorOpenPrCap).toBeNull(); // documented null-clear example
  });
});

describe("the two examples together demonstrate the documented overlay behavior", () => {
  it("merges exactly as config/examples/README.md describes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-example-config-"));
    writeFileSync(join(dir, ".gittensory.yml"), readExample("global.gittensory.yml"));
    mkdirSync(join(dir, "owner__repo"));
    writeFileSync(join(dir, "owner__repo", ".gittensory.yml"), readExample("repo-override.gittensory.yml"));
    const reader = makeLocalManifestReader(dir)!;
    const manifest = parseFocusManifestContent(await reader("owner/repo"));

    expect(manifest.gate.enabled).toBe(true); // set the same way in both files
    expect(manifest.gate.duplicates).toBe("block"); // inherited from global; repo-override never mentions it
    expect(manifest.wantedPaths).toEqual(["src/**"]); // repo-override's array replaces global's (global sets none)
    expect(manifest.settings.contributorOpenPrCap).toBeNull(); // repo-override's explicit null clears global's 3
    expect(manifest.settings.autoCloseExemptLogins).toEqual(["your-admin-login"]); // inherited from global untouched
  });
});
