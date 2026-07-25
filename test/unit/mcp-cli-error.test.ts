import { afterEach, describe, expect, it, vi } from "vitest";
import { argsWantJson, describeCliError, reportCliFailure, waitForStdioFlush } from "../../packages/loopover-mcp/lib/cli-error.js";

describe("mcp cli-error (#5928)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reportCliFailure logs plain text to stderr when --json is absent", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(reportCliFailure(false, "bad args")).toBe(2);
    expect(err).toHaveBeenCalledWith("bad args");
    expect(log).not.toHaveBeenCalled();
  });

  it("reportCliFailure emits parseable JSON on stdout when --json is set, honoring a custom exit code", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(reportCliFailure(true, "bad args", 1)).toBe(1);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "bad args" }, null, 2));
    expect(err).not.toHaveBeenCalled();
  });

  it("defaults the exit code to 2 when omitted", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportCliFailure(false, "bad args")).toBe(2);
  });

  it("argsWantJson detects --json and --json=... in argv", () => {
    expect(argsWantJson(["discover", "acme/widgets", "--json"])).toBe(true);
    expect(argsWantJson(["discover", "--json=pretty"])).toBe(true);
    expect(argsWantJson(["discover", "acme/widgets"])).toBe(false);
    expect(argsWantJson([])).toBe(false);
  });

  it("describeCliError normalizes thrown values", () => {
    expect(describeCliError(new Error("boom"))).toBe("boom");
    expect(describeCliError("plain")).toBe("plain");
    expect(describeCliError(42)).toBe("42");
  });

  describe("waitForStdioFlush (#8606)", () => {
    it("resolves without waiting a tick when every stream is already fully drained", async () => {
      const settled = vi.fn();
      void waitForStdioFlush([{ writableLength: 0 }, { writableLength: 0 }]).then(settled);
      // A poll that finds nothing buffered resolves synchronously inside the executor, before any
      // setImmediate is ever scheduled -- only a microtask tick (not a macrotask) should be needed.
      await Promise.resolve();
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it("keeps polling until every stream drains, then resolves", async () => {
      const stdout = { writableLength: 12 };
      const stderr = { writableLength: 0 };
      const settled = vi.fn();
      void waitForStdioFlush([stdout, stderr]).then(settled);

      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();

      stdout.writableLength = 0;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it("treats an empty stream list as already flushed", async () => {
      await expect(waitForStdioFlush([])).resolves.toBeUndefined();
    });
  });
});
