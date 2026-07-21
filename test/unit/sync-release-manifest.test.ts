import { describe, expect, it, vi } from "vitest";
import { main, MANIFEST_PATH, syncManifestVersions } from "../../scripts/sync-release-manifest.js";

const SAMPLE_MANIFEST = JSON.stringify(
  {
    "packages/loopover-mcp": "3.1.0",
    "packages/loopover-engine": "3.2.0",
    "packages/loopover-miner": "3.1.0",
  },
  null,
  2,
);

describe("syncManifestVersions (#release-manifest-drift)", () => {
  it("rewrites a stale entry to match the real package.json version", () => {
    const result = syncManifestVersions(SAMPLE_MANIFEST, { "packages/loopover-mcp": "3.1.1" });
    expect(result.changed).toBe(true);
    expect(result.stale).toEqual([{ workspacePath: "packages/loopover-mcp", from: "3.1.0", to: "3.1.1" }]);
    expect(JSON.parse(result.content)["packages/loopover-mcp"]).toBe("3.1.1");
    // Untouched entries survive the round-trip unchanged.
    expect(JSON.parse(result.content)["packages/loopover-engine"]).toBe("3.2.0");
  });

  it("reports no drift and leaves content byte-identical when every version already matches", () => {
    const result = syncManifestVersions(SAMPLE_MANIFEST, {
      "packages/loopover-mcp": "3.1.0",
      "packages/loopover-engine": "3.2.0",
      "packages/loopover-miner": "3.1.0",
    });
    expect(result.changed).toBe(false);
    expect(result.stale).toEqual([]);
    expect(result.content).toBe(SAMPLE_MANIFEST);
  });

  it("ignores a package.json version for a workspace the manifest doesn't track", () => {
    const result = syncManifestVersions(SAMPLE_MANIFEST, { "packages/loopover-ui-kit": "9.9.9" });
    expect(result.changed).toBe(false);
    expect(result.stale).toEqual([]);
    expect(JSON.parse(result.content)).not.toHaveProperty("packages/loopover-ui-kit");
  });

  it("collects every stale entry, not just the first", () => {
    const result = syncManifestVersions(SAMPLE_MANIFEST, {
      "packages/loopover-mcp": "3.1.1",
      "packages/loopover-miner": "3.1.1",
    });
    expect(result.stale.map((entry) => entry.workspacePath)).toEqual([
      "packages/loopover-mcp",
      "packages/loopover-miner",
    ]);
    expect(JSON.parse(result.content)["packages/loopover-mcp"]).toBe("3.1.1");
    expect(JSON.parse(result.content)["packages/loopover-miner"]).toBe("3.1.1");
  });
});

function fakeIo(packageVersions: Record<string, string>) {
  const written = new Map<string, string>();
  const readFileSync = vi.fn((path: string) => {
    if (path === MANIFEST_PATH) return SAMPLE_MANIFEST;
    const match = /^(.+)\/package\.json$/.exec(path);
    const key = match?.[1];
    if (key !== undefined && key in packageVersions) {
      return JSON.stringify({ version: packageVersions[key] });
    }
    throw new Error(`unexpected read: ${path}`);
  });
  const writeFileSync = vi.fn((path: string, content: string) => {
    written.set(path, content);
  });
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  return { readFileSync, writeFileSync, log, error, exit, written };
}

describe("sync-release-manifest main (#release-manifest-drift)", () => {
  it("--check exits non-zero and never writes when the manifest is stale", () => {
    const io = fakeIo({
      "packages/loopover-mcp": "3.1.1",
      "packages/loopover-engine": "3.2.0",
      "packages/loopover-miner": "3.1.1",
    });

    const code = main(["--check"], io);

    expect(code).toBe(1);
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.error).toHaveBeenCalledWith(
      expect.stringContaining("packages/loopover-mcp is 3.1.0, package.json says 3.1.1"),
    );
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining("run npm run release-manifest:sync"));
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });

  it("--check exits 0 and logs a clean summary when everything already matches", () => {
    const io = fakeIo({
      "packages/loopover-mcp": "3.1.0",
      "packages/loopover-engine": "3.2.0",
      "packages/loopover-miner": "3.1.0",
    });

    const code = main(["--check"], io);

    expect(code).toBe(0);
    expect(io.exit).not.toHaveBeenCalled();
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(
      expect.stringContaining("checked 3 package version(s), all in sync"),
    );
  });

  it("without --check, writes the synced manifest and reports how many entries changed", () => {
    const io = fakeIo({
      "packages/loopover-mcp": "3.1.1",
      "packages/loopover-engine": "3.2.0",
      "packages/loopover-miner": "3.1.1",
    });

    const code = main([], io);

    expect(code).toBe(0);
    expect(io.exit).not.toHaveBeenCalled();
    expect(io.writeFileSync).toHaveBeenCalledOnce();
    const [writtenPath, writtenContent] = io.writeFileSync.mock.calls[0]!;
    expect(writtenPath).toBe(MANIFEST_PATH);
    expect(JSON.parse(writtenContent as string)).toEqual({
      "packages/loopover-mcp": "3.1.1",
      "packages/loopover-engine": "3.2.0",
      "packages/loopover-miner": "3.1.1",
    });
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("synced 2 of 3 package version(s)"));
  });

  it("without --check, never writes when nothing is stale", () => {
    const io = fakeIo({
      "packages/loopover-mcp": "3.1.0",
      "packages/loopover-engine": "3.2.0",
      "packages/loopover-miner": "3.1.0",
    });

    const code = main([], io);

    expect(code).toBe(0);
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("checked of 3 package version(s)"));
  });
});
