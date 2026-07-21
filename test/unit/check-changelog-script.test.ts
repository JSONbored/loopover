import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- plain .mjs script with no type declarations
import { run } from "../../scripts/check-changelog.mjs";

/**
 * #7772: when a command can't even launch (binary missing from PATH), spawnSync returns `status: null` with
 * the real ENOENT/EACCES reason on `result.error`. `run()` used to fall back to a generic `"<label> failed"`
 * string, discarding that reason. It now surfaces `result.error.message`, so a misconfigured dependency
 * produces an actionable error instead of a mystery.
 */
describe("check-changelog run() launch-failure reporting (#7772)", () => {
  it("surfaces the real spawn error when the command cannot launch (real ENOENT)", () => {
    let captured = "";
    let exitCode: number | undefined;
    run(["loopover-definitely-not-a-real-binary-xyz"], "root changelog", {
      onFailure: (message: string, code: number) => {
        captured = message;
        exitCode = code;
      },
    });

    // The message carries the actual reason (spawn ENOENT ...), labeled -- not the generic "... failed".
    expect(captured).toContain("root changelog");
    expect(captured).toMatch(/ENOENT|spawn/);
    expect(captured).not.toBe("root changelog failed");
    expect(exitCode).toBe(1);
  });

  it("still falls back to the generic label when there is no error and no output (nonzero exit only)", () => {
    // A command that ran but exited non-zero with empty streams and no launch error -> generic fallback.
    const spawn = vi.fn(() => ({ status: 2, stdout: "", stderr: "", error: undefined }));
    let captured = "";
    let exitCode: number | undefined;
    run(["anything"], "MCP package changelog", {
      spawn: spawn as unknown as typeof import("node:child_process").spawnSync,
      onFailure: (message: string, code: number) => {
        captured = message;
        exitCode = code;
      },
    });

    expect(captured).toBe("MCP package changelog failed");
    expect(exitCode).toBe(2);
  });

  it("prefers real stderr/stdout output over the launch-error fallback", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: "", stderr: "cliff: bad config\n", error: undefined }));
    let captured = "";
    run(["git-cliff"], "root changelog", {
      spawn: spawn as unknown as typeof import("node:child_process").spawnSync,
      onFailure: (message: string) => {
        captured = message;
      },
    });

    expect(captured).toBe("cliff: bad config\n");
  });

  it("does nothing on success (status 0)", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "", stderr: "", error: undefined }));
    const onFailure = vi.fn();
    run(["git-cliff"], "root changelog", {
      spawn: spawn as unknown as typeof import("node:child_process").spawnSync,
      onFailure,
    });

    expect(onFailure).not.toHaveBeenCalled();
  });
});
