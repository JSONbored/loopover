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
    // #label-scoping: the recommended one-shot autonomy baseline — close authorizes enforcement
    // labels + terminal disposition; review_state_label is intentionally left at the default (unset).
    expect(manifest.settings.autonomy).toEqual({ close: "auto" });
    expect(manifest.settings.reviewNagPolicy).toBe("hold");
    expect(manifest.settings.reviewNagMaxPings).toBe(3);
    expect(manifest.settings.reviewNagCooldownDays).toBe(5);
    expect(manifest.settings.reviewNagMonitoredMentions).toEqual(["your-maintainer-login"]);
  });
});

describe("config/examples/shared.gittensory.yml (#1959)", () => {
  it("parses cleanly with no warnings and sets the documented fields", () => {
    const manifest = parseFocusManifestContent(readExample("shared.gittensory.yml"));
    expect(manifest.warnings).toEqual([]);
    expect(manifest.present).toBe(true);
    expect(manifest.review.tone).toBe("friendly-terse");
    expect(manifest.wantedPaths).toEqual(["src/**", "test/**"]);
    expect(manifest.gate.duplicates).toBe("block");
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
    expect(manifest.settings.contributorCapLabel).toBeNull(); // #label-scoping: close without any label
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
    expect(manifest.settings.contributorCapLabel).toBeNull(); // repo-override clears the (unset) global default too
    expect(manifest.settings.autoCloseExemptLogins).toEqual(["your-admin-login"]); // inherited from global untouched
    expect(manifest.settings.autonomy).toEqual({ close: "auto" }); // inherited from global untouched (repo-override never mentions it)
  });
});

describe("all three examples together demonstrate the documented shared-base overlay (#1959)", () => {
  it("merges shared → global → per-repo exactly as config/examples/README.md describes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-example-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".gittensory.yml"), readExample("shared.gittensory.yml"));
    writeFileSync(join(dir, ".gittensory.yml"), readExample("global.gittensory.yml"));
    mkdirSync(join(dir, "owner__repo"));
    writeFileSync(join(dir, "owner__repo", ".gittensory.yml"), readExample("repo-override.gittensory.yml"));
    const reader = makeLocalManifestReader(dir)!;
    const manifest = parseFocusManifestContent(await reader("owner/repo"));

    expect(manifest.review.tone).toBe("friendly-terse"); // inherited from the shared base; neither global nor repo-override mentions it
    expect(manifest.gate.duplicates).toBe("block"); // shared base and global agree; still inherited, not overridden
    expect(manifest.gate.enabled).toBe(true); // set by both global and repo-override, shared base is silent on it
    expect(manifest.wantedPaths).toEqual(["src/**"]); // repo-override's array wins wholesale over shared's AND global's
    expect(manifest.settings.contributorOpenPrCap).toBeNull(); // repo-override's explicit null still clears global's 3
  });
});
