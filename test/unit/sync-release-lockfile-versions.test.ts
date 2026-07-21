import { describe, expect, it, vi } from "vitest";
import { main, syncLockfileVersions } from "../../scripts/sync-release-lockfile-versions.js";

const SAMPLE_LOCK = `{
  "name": "loopover",
  "lockfileVersion": 3,
  "packages": {
    "packages/loopover-engine": {
      "name": "@loopover/engine",
      "version": "1.0.0",
      "license": "AGPL-3.0-only"
    },
    "packages/loopover-mcp": {
      "name": "@loopover/mcp",
      "version": "2.0.0",
      "license": "AGPL-3.0-only"
    }
  }
}
`;

describe("syncLockfileVersions (#6296)", () => {
  it("updates a workspace version when the lockfile block matches", () => {
    const result = syncLockfileVersions(SAMPLE_LOCK, [{ workspacePath: "packages/loopover-engine", version: "1.2.3" }]);
    expect(result.changed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.content).toContain('"version": "1.2.3"');
    expect(result.content).toContain('"name": "@loopover/engine"');
  });

  it("records a match failure without stopping later workspaces, and leaves content unchanged for misses", () => {
    const result = syncLockfileVersions(SAMPLE_LOCK, [
      { workspacePath: "packages/missing-workspace", version: "9.9.9" },
      { workspacePath: "packages/loopover-mcp", version: "3.0.0" },
    ]);
    expect(result.failures).toEqual(["packages/missing-workspace"]);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"version": "3.0.0"');
    expect(result.content).not.toContain("9.9.9");
  });

  it("reports already-at when the version is unchanged", () => {
    const onAlready = vi.fn();
    const result = syncLockfileVersions(
      SAMPLE_LOCK,
      [{ workspacePath: "packages/loopover-engine", version: "1.0.0" }],
      { onAlready },
    );
    expect(result.changed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(onAlready).toHaveBeenCalledWith("packages/loopover-engine", "1.0.0");
  });
});

describe("sync-release-lockfile-versions main exit code (#6296)", () => {
  it("exits non-zero when any workspace pattern fails to match", () => {
    const exit = vi.fn();
    const error = vi.fn();
    const log = vi.fn();
    const writeFileSync = vi.fn();
    const readFileSync = vi.fn((path: string) => {
      if (path === "package-lock.json") return SAMPLE_LOCK;
      if (path === "packages/missing-workspace/package.json") return JSON.stringify({ version: "9.9.9" });
      if (path === "packages/loopover-mcp/package.json") return JSON.stringify({ version: "3.0.0" });
      throw new Error(`unexpected read: ${path}`);
    });

    const code = main(["packages/missing-workspace", "packages/loopover-mcp"], {
      readFileSync,
      writeFileSync,
      log,
      error,
      exit,
    });

    expect(code).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("packages/missing-workspace: pattern not found"),
    );
    // Successful workspaces still sync before the non-zero exit.
    expect(writeFileSync).toHaveBeenCalledWith("package-lock.json", expect.stringContaining('"version": "3.0.0"'));
    expect(log).toHaveBeenCalledWith("packages/loopover-mcp: synced to 3.0.0.");
  });

  it("exits via usage error when no workspace paths are provided", () => {
    const exit = vi.fn();
    const error = vi.fn();
    const code = main([], {
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      log: vi.fn(),
      error,
      exit,
    });
    expect(code).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
  });
});
