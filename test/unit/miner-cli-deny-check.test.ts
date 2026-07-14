import { describe, expect, it, vi } from "vitest";
import { parseDenyCheckArgs, runDenyCheck } from "../../packages/gittensory-miner/lib/deny-check.js";

describe("loopover-miner hooks check command", () => {
  it("parseDenyCheckArgs requires tool and JSON input", () => {
    expect(parseDenyCheckArgs([])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner hooks check"),
    });
    expect(parseDenyCheckArgs(["--tool", "Write"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner hooks check"),
    });
    expect(parseDenyCheckArgs(["--tool", "Write", "--input", "[]"])).toEqual({
      error: "Tool input must be a JSON object.",
    });
    expect(
      parseDenyCheckArgs([
        "--tool",
        "Write",
        "--input",
        '{"file_path":"src/a.ts"}',
        "--json",
      ]),
    ).toEqual({
      tool: "Write",
      input: { file_path: "src/a.ts" },
      json: true,
    });
  });

  it("runDenyCheck exits 1 when a built-in rule blocks the call", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runDenyCheck([
        "--tool",
        "Write",
        "--input",
        '{"file_path":".github/workflows/ci.yml"}',
      ]),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CI workflows"));
  });

  it("runDenyCheck exits 0 for allowed calls and prints JSON when requested", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runDenyCheck([
        "--tool",
        "Write",
        "--input",
        '{"file_path":"src/a.ts"}',
        "--json",
      ]),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"allowed":true'));
  });

  it("runDenyCheck returns exit code 2 for malformed flags", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runDenyCheck(["--tool", "Write", "--input", "{bad json"])).toBe(2);
    expect(error).toHaveBeenCalledWith("Tool input must be valid JSON.");
  });
});
