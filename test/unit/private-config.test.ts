import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localConfigCandidates, makeLocalManifestReader } from "../../src/selfhost/private-config";

describe("localConfigCandidates (container-private config filenames)", () => {
  it("builds lowercased {owner}__{repo} candidates in .yml/.yaml/.json order", () => {
    expect(localConfigCandidates("JSONbored/metagraphed")).toEqual(["jsonbored__metagraphed.yml", "jsonbored__metagraphed.yaml", "jsonbored__metagraphed.json"]);
  });
  it("returns no candidates for an invalid repo full name", () => {
    expect(localConfigCandidates("no-slash")).toEqual([]); // slash < 0 → slash <= 0
    expect(localConfigCandidates("/leading")).toEqual([]); // slash at 0 → slash <= 0
    expect(localConfigCandidates("trailing/")).toEqual([]); // slash at len-1
  });
});

describe("makeLocalManifestReader (GITTENSORY_REPO_CONFIG_DIR)", () => {
  it("returns null when the dir is unset or blank (⇒ public fetch)", () => {
    expect(makeLocalManifestReader(undefined)).toBeNull(); // ?? right side
    expect(makeLocalManifestReader("")).toBeNull();
    expect(makeLocalManifestReader("   ")).toBeNull(); // blank after trim
  });

  it("reads the first existing {owner}__{repo} file and returns its text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, "jsonbored__metagraphed.yml"), "gate:\n  enabled: false\n");
    const reader = makeLocalManifestReader(dir);
    expect(reader).not.toBeNull();
    expect(await reader!("JSONbored/metagraphed")).toBe("gate:\n  enabled: false\n");
  });

  it("falls through .yml → .yaml → .json when earlier candidates are absent (read error → next)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, "owner__repo.json"), '{"gate":{"enabled":true}}');
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("owner/repo")).toBe('{"gate":{"enabled":true}}');
  });

  it("returns null when no private config file exists for the repo (⇒ loader uses the public file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("owner/unconfigured")).toBeNull();
  });

  it("returns null for an invalid repo full name (no candidates to try)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("no-slash")).toBeNull();
  });
});
