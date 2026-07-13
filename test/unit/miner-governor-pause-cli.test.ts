import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDefaultGovernorState, openGovernorState } from "../../packages/gittensory-miner/lib/governor-state.js";
import {
  parseGovernorPauseArgs,
  parseGovernorResumeArgs,
  runGovernorPause,
  runGovernorResume,
  runGovernorStatus,
} from "../../packages/gittensory-miner/lib/governor-pause-cli.js";

const roots: string[] = [];
const states: Array<{ close(): void }> = [];

function tempGovernorState() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-pause-cli-"));
  roots.push(root);
  const state = openGovernorState(join(root, "governor-state.sqlite3"));
  states.push(state);
  return state;
}

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  closeDefaultGovernorState();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseGovernorPauseArgs (#4851)", () => {
  it("defaults to no reason and non-JSON output", () => {
    expect(parseGovernorPauseArgs([])).toEqual({ json: false, dryRun: false, reason: null });
  });

  it("parses --reason, --dry-run, and --json together", () => {
    expect(parseGovernorPauseArgs(["--reason", "investigating a bad PR", "--dry-run", "--json"])).toEqual({
      json: true,
      dryRun: true,
      reason: "investigating a bad PR",
    });
  });

  it("rejects a --reason flag missing its value", () => {
    expect(parseGovernorPauseArgs(["--reason"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner governor pause"),
    });
    expect(parseGovernorPauseArgs(["--reason", "--json"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner governor pause"),
    });
  });

  it("rejects an unknown option", () => {
    expect(parseGovernorPauseArgs(["--verbose"])).toEqual({ error: "Unknown option: --verbose" });
  });
});

describe("parseGovernorResumeArgs (#4847)", () => {
  it("defaults to non-dry-run, non-JSON output", () => {
    expect(parseGovernorResumeArgs([])).toEqual({ json: false, dryRun: false });
  });

  it("parses --dry-run and --json together", () => {
    expect(parseGovernorResumeArgs(["--dry-run", "--json"])).toEqual({ json: true, dryRun: true });
  });

  it("rejects an unrecognized token", () => {
    expect(parseGovernorResumeArgs(["extra"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner governor resume"),
    });
  });
});

describe("gittensory-miner governor pause/resume/status CLI (#4851)", () => {
  it("pauses with a reason, then resumes, using an injected governor state", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runGovernorPause(["--reason", "operator requested", "--json"], {
        openGovernorState: () => governorState,
      }),
    ).toBe(0);
    const paused = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(paused).toMatchObject({ paused: true, reason: "operator requested" });
    expect(governorState.loadPauseState()).toMatchObject({ paused: true, reason: "operator requested" });

    log.mockClear();
    expect(await runGovernorResume([], { openGovernorState: () => governorState })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe("governor is not paused");
    expect(governorState.loadPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
  });

  it("pauses with no reason and renders the plain-text form", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runGovernorPause([], { openGovernorState: () => governorState })).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("governor is PAUSED since");
    expect(text).not.toContain("(");
  });

  it("status reports the current pause state without mutating it", async () => {
    const governorState = tempGovernorState();
    governorState.savePauseState({ paused: true, reason: "halting for review" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runGovernorStatus(["--json"], { openGovernorState: () => governorState })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      paused: true,
      reason: "halting for review",
    });
    expect(governorState.loadPauseState()).toMatchObject({ paused: true, reason: "halting for review" });
  });

  it("resume and status reject stray positional arguments", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runGovernorResume(["extra"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: gittensory-miner governor resume");

    error.mockClear();
    expect(await runGovernorStatus(["extra"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: gittensory-miner governor status");
  });

  it("#4847: --dry-run reports what pause/resume would do and returns 0 without opening the governor state", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const openGovernorStateSpy = vi.fn();

    expect(
      await runGovernorPause(["--reason", "operator requested", "--dry-run", "--json"], {
        openGovernorState: openGovernorStateSpy,
      }),
    ).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "dry_run",
      paused: true,
      reason: "operator requested",
    });

    log.mockClear();
    expect(await runGovernorPause(["--dry-run"], { openGovernorState: openGovernorStateSpy })).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toBe("DRY RUN: would pause the governor. No governor-state write was made.");

    log.mockClear();
    expect(
      await runGovernorPause(["--reason", "operator requested", "--dry-run"], {
        openGovernorState: openGovernorStateSpy,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe(
      "DRY RUN: would pause the governor (operator requested). No governor-state write was made.",
    );

    log.mockClear();
    expect(
      await runGovernorResume(["--dry-run", "--json"], { openGovernorState: openGovernorStateSpy }),
    ).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ outcome: "dry_run", paused: false });

    log.mockClear();
    expect(await runGovernorResume(["--dry-run"], { openGovernorState: openGovernorStateSpy })).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toBe("DRY RUN: would resume the governor. No governor-state write was made.");
  });

  it("rejects an unknown pause option before opening any store", async () => {
    const openGovernorStateFn = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runGovernorPause(["--verbose"], { openGovernorState: openGovernorStateFn })).toBe(2);
    expect(openGovernorStateFn).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown option");
  });

  it("closes an owned (non-injected) governor state and surfaces a real open failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const openGovernorStateFn = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(await runGovernorStatus([], { openGovernorState: openGovernorStateFn })).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("disk full");
  });

  it("runGovernorStatus prints plain text by default and surfaces a non-Error thrown failure", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runGovernorStatus([], { openGovernorState: () => governorState })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe("governor is not paused");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runGovernorStatus([], {
        openGovernorState: () => {
          throw "boom";
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("boom");
  });

  it("runGovernorPause surfaces both an Error and a non-Error thrown open failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runGovernorPause([], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("disk full");

    error.mockClear();
    expect(
      await runGovernorPause([], {
        openGovernorState: () => {
          throw "boom";
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("boom");
  });

  it("runGovernorResume surfaces both an Error and a non-Error thrown open failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runGovernorResume([], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("disk full");

    error.mockClear();
    expect(
      await runGovernorResume([], {
        openGovernorState: () => {
          throw "boom";
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("boom");
  });

  it("opens and closes the default on-disk governor state when no override is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-pause-cli-default-"));
    roots.push(root);
    const dbPath = join(root, "governor-state.sqlite3");
    const previousDbPath = process.env.GITTENSORY_MINER_GOVERNOR_STATE_DB;
    process.env.GITTENSORY_MINER_GOVERNOR_STATE_DB = dbPath;
    try {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runGovernorPause(["--reason", "default path"])).toBe(0);

      const reopened = openGovernorState(dbPath);
      states.push(reopened);
      expect(reopened.loadPauseState()).toMatchObject({ paused: true, reason: "default path" });
    } finally {
      if (previousDbPath === undefined) delete process.env.GITTENSORY_MINER_GOVERNOR_STATE_DB;
      else process.env.GITTENSORY_MINER_GOVERNOR_STATE_DB = previousDbPath;
    }
  });
});
