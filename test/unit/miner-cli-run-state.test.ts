import { afterEach, describe, expect, it, vi } from "vitest";

const getRunState = vi.fn();
const setRunState = vi.fn();

vi.mock("../../packages/gittensory-miner/lib/run-state.js", () => ({
  RUN_STATES: ["idle", "discovering", "planning", "preparing"],
  getRunState,
  setRunState,
}));

const {
  parseStateGetArgs,
  parseStateSetArgs,
  runStateGet,
  runStateSet,
} = await import("../../packages/gittensory-miner/lib/run-state-cli.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("gittensory-miner state CLI", () => {
  it("parseStateGetArgs and parseStateSetArgs validate argv", () => {
    expect(parseStateGetArgs([])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner state get"),
    });
    expect(parseStateGetArgs(["acme/widgets", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      json: true,
    });
    expect(parseStateSetArgs(["acme/widgets", "planning"])).toEqual({
      repoFullName: "acme/widgets",
      state: "planning",
      json: false,
    });
    expect(parseStateSetArgs(["acme/widgets", "bogus"])).toEqual({
      error: expect.stringMatching(/Invalid state/),
    });
  });

  it("runStateGet prints none before any write", () => {
    getRunState.mockReturnValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runStateGet(["acme/widgets"])).toBe(0);
    expect(getRunState).toHaveBeenCalledWith("acme/widgets");
    expect(log).toHaveBeenCalledWith("none");
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

  it("runStateSet returns exit code 2 for malformed repositories", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runStateSet(["not-a-repo", "idle"])).toBe(2);
    expect(error).toHaveBeenCalledWith("Repository must be in owner/repo form.");
    expect(setRunState).not.toHaveBeenCalled();
  });

  it("runStateGet returns exit code 2 when the store read fails", () => {
    getRunState.mockImplementation(() => {
      throw new Error("invalid_repo_full_name");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runStateGet(["acme/widgets"])).toBe(2);
    expect(error).toHaveBeenCalledWith("invalid_repo_full_name");
  });
});
