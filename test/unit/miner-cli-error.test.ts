import { afterEach, describe, expect, it, vi } from "vitest";
import {
  argsWantJson,
  describeCliError,
  reportCliFailure,
} from "../../packages/gittensory-miner/lib/cli-error.js";

describe("cli-error (#4836)", () => {
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

  it("reportCliFailure emits parseable JSON on stdout when --json is set", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(reportCliFailure(true, "bad args", 2)).toBe(2);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "bad args" }, null, 2));
    expect(err).not.toHaveBeenCalled();
  });

  it("argsWantJson detects --json in argv", () => {
    expect(argsWantJson(["discover", "acme/widgets", "--json"])).toBe(true);
    expect(argsWantJson(["discover", "acme/widgets"])).toBe(false);
  });

  it("describeCliError normalizes thrown values", () => {
    expect(describeCliError(new Error("boom"))).toBe("boom");
    expect(describeCliError("plain")).toBe("plain");
  });
});
