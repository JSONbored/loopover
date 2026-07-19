import { afterEach, describe, expect, it, vi } from "vitest";

const getRunState = vi.fn();
const setRunState = vi.fn();

vi.mock("../../packages/loopover-miner/lib/run-state.js", () => ({
  RUN_STATES: ["idle", "discovering", "planning", "preparing"],
  getRunState,
  setRunState,
}));

const {
  parseStateGetArgs,
  parseStateSetArgs,
  runStateGet,
  runStateSet,
  runStateCli,
} = await import("../../packages/loopover-miner/lib/run-state-cli.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("loopover-miner state CLI", () => {
  it("parseStateGetArgs and parseStateSetArgs validate argv", () => {
    expect(parseStateGetArgs([])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner state get"),
    });
    expect(parseStateGetArgs(["acme/widgets", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      json: true,
    });
    expect(parseStateSetArgs(["acme/widgets", "planning"])).toEqual({
      repoFullName: "acme/widgets",
      state: "planning",
      dryRun: false,
      json: false,
    });
    expect(parseStateSetArgs(["acme/widgets", "bogus"])).toEqual({
      error: expect.stringMatching(/Invalid state/),
    });
  });

  it("parseStateGetArgs and parseStateSetArgs accept --api-base-url (#5563)", () => {
    expect(parseStateGetArgs(["acme/widgets", "--api-base-url", "https://ghe.example.com/api/v3"])).toEqual({
      repoFullName: "acme/widgets",
      json: false,
      apiBaseUrl: "https://ghe.example.com/api/v3",
    });
    expect(parseStateGetArgs(["acme/widgets", "--api-base-url"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner state get"),
    });
    expect(parseStateSetArgs(["acme/widgets", "planning", "--api-base-url", "https://ghe.example.com/api/v3"])).toEqual({
      repoFullName: "acme/widgets",
      state: "planning",
      dryRun: false,
      json: false,
      apiBaseUrl: "https://ghe.example.com/api/v3",
    });
    expect(parseStateSetArgs(["acme/widgets", "planning", "--api-base-url"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner state set"),
    });
  });

  it("runStateGet prints none before any write", () => {
    getRunState.mockReturnValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runStateGet(["acme/widgets"])).toBe(0);
    expect(getRunState).toHaveBeenCalledWith("acme/widgets", undefined);
    expect(log).toHaveBeenCalledWith("none");
  });

  it("runStateGet and runStateSet thread --api-base-url through to the store (#5563)", () => {
    getRunState.mockReturnValue("planning");
    setRunState.mockReturnValue({
      apiBaseUrl: "https://ghe.example.com/api/v3",
      repoFullName: "acme/widgets",
      state: "planning",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    expect(runStateGet(["acme/widgets", "--api-base-url", "https://ghe.example.com/api/v3"])).toBe(0);
    expect(getRunState).toHaveBeenCalledWith("acme/widgets", "https://ghe.example.com/api/v3");

    expect(runStateSet(["acme/widgets", "planning", "--api-base-url", "https://ghe.example.com/api/v3"])).toBe(0);
    expect(setRunState).toHaveBeenCalledWith("acme/widgets", "planning", "https://ghe.example.com/api/v3");
  });

  it("runStateSet persists state and runStateGet returns JSON output", () => {
    setRunState.mockReturnValue({
      repoFullName: "acme/widgets",
      state: "discovering",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    getRunState.mockReturnValue("discovering");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runStateSet(["acme/widgets", "discovering", "--json"])).toBe(0);
    expect(runStateGet(["acme/widgets", "--json"])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"state":"discovering"'),
    );
  });

  it("#4847: --dry-run reports what a state set would do and returns 0 without writing the run-state store", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runStateSet(["acme/widgets", "planning", "--dry-run", "--json"])).toBe(0);
    expect(setRunState).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "dry_run",
      repoFullName: "acme/widgets",
      state: "planning",
    });

    log.mockClear();
    expect(runStateSet(["acme/widgets", "planning", "--dry-run"])).toBe(0);
    expect(setRunState).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain('DRY RUN: would set acme/widgets\'s run state to "planning"');
  });

  it("runStateSet returns exit code 2 for malformed repositories", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runStateSet(["not-a-repo", "idle"])).toBe(2);
    expect(error).toHaveBeenCalledWith("Repository must be in owner/repo form.");
    expect(setRunState).not.toHaveBeenCalled();
    error.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runStateSet(["not-a-repo", "idle", "--json"])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "Repository must be in owner/repo form.",
    });
  });

  it("parseStateGetArgs rejects unknown flags, an empty repo token, and a malformed repo", () => {
    expect(parseStateGetArgs(["acme/widgets", "--bogus"])).toEqual({
      error: "Unknown option: --bogus",
    });
    // An empty positional token trips the falsy-value guard inside parseRepoArg.
    expect(parseStateGetArgs([""])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner state get"),
    });
    expect(parseStateGetArgs(["not-a-repo"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
  });

  it("parseStateSetArgs rejects unknown flags and the wrong positional count", () => {
    expect(parseStateSetArgs(["acme/widgets", "planning", "-x"])).toEqual({
      error: "Unknown option: -x",
    });
    expect(parseStateSetArgs(["acme/widgets"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner state set"),
    });
    expect(parseStateSetArgs(["acme/widgets", "planning", "extra"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner state set"),
    });
  });

  it("runStateCli dispatches get and set and rejects unknown subcommands", () => {
    getRunState.mockReturnValue(null);
    setRunState.mockReturnValue({
      repoFullName: "acme/widgets",
      state: "idle",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runStateCli("get", ["acme/widgets"])).toBe(0);
    expect(getRunState).toHaveBeenCalledWith("acme/widgets", undefined);
    expect(runStateCli("set", ["acme/widgets", "idle"])).toBe(0);
    expect(setRunState).toHaveBeenCalledWith("acme/widgets", "idle", undefined);
    log.mockRestore();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runStateCli("bogus", [])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unknown state subcommand: bogus"));
    // An undefined subcommand exercises the nullish-coalescing fallback in the message.
    expect(runStateCli(undefined, [])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unknown state subcommand: ."));
  });

  it("runStateGet returns exit code 2 when the store read fails", () => {
    getRunState.mockImplementation(() => {
      throw new Error("invalid_repo_full_name");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runStateGet(["acme/widgets"])).toBe(2);
    expect(error).toHaveBeenCalledWith("invalid_repo_full_name");
    error.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runStateGet(["acme/widgets", "--json"])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "invalid_repo_full_name",
    });
  });
});
