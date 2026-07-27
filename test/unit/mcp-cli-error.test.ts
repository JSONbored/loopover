import { afterEach, describe, expect, it, vi } from "vitest";
import { argsWantJson, describeCliError, reportCliFailure } from "../../packages/loopover-mcp/lib/cli-error";

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

  it("argsWantJson treats the explicit --json=false disable as NOT wanting JSON (#8689)", () => {
    expect(argsWantJson(["whoami", "--json=false"])).toBe(false);
    expect(argsWantJson(["whoami", "--json=true"])).toBe(true);
    // A later enabling form still wins over an earlier disable, matching parseOptions' last-write behavior.
    expect(argsWantJson(["whoami", "--json=false", "--json"])).toBe(true);
  });

  it("describeCliError normalizes thrown values", () => {
    expect(describeCliError(new Error("boom"))).toBe("boom");
    expect(describeCliError("plain")).toBe("plain");
    expect(describeCliError(42)).toBe("42");
  });
});
