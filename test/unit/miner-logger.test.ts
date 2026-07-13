import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureLogger,
  createLogger,
  DEFAULT_LOG_LEVEL,
  extractLogOptions,
  formatFields,
  formatLine,
  getLogger,
  isLogLevel,
  LOG_LEVELS,
  resolveLogLevel,
} from "../../packages/gittensory-miner/lib/logger.js";

// A pair of in-memory streams so a logger's output can be asserted without touching real stdio.
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: {
        write: (chunk: string) => {
          out.push(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          err.push(chunk);
          return true;
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  configureLogger(); // reset the process-wide logger to its default so tests don't leak state
});

describe("log level constants (#4835)", () => {
  it("exposes the ordered level list and a default", () => {
    expect(LOG_LEVELS).toEqual(["silent", "error", "warn", "info", "debug"]);
    expect(DEFAULT_LOG_LEVEL).toBe("info");
  });
});

describe("isLogLevel (#4835)", () => {
  it("accepts known levels and rejects unknown or non-string input", () => {
    expect(isLogLevel("info")).toBe(true);
    expect(isLogLevel("silent")).toBe(true);
    expect(isLogLevel("bogus")).toBe(false); // string, but not a level
    expect(isLogLevel(5)).toBe(false); // not a string
    expect(isLogLevel(undefined)).toBe(false);
  });
});

describe("resolveLogLevel (#4835)", () => {
  it("prefers an explicit valid level above every other signal", () => {
    expect(resolveLogLevel({ level: "warn", quiet: true, verbose: true, envLevel: "debug" })).toBe("warn");
  });

  it("maps --quiet to error and --verbose to debug, with quiet winning a contradiction", () => {
    expect(resolveLogLevel({ quiet: true })).toBe("error");
    expect(resolveLogLevel({ verbose: true })).toBe("debug");
    expect(resolveLogLevel({ quiet: true, verbose: true })).toBe("error");
  });

  it("falls back to a valid env level, then the default, ignoring typos", () => {
    expect(resolveLogLevel({ envLevel: "debug" })).toBe("debug");
    expect(resolveLogLevel({ envLevel: "nope" })).toBe(DEFAULT_LOG_LEVEL); // invalid env ignored
    expect(resolveLogLevel({ level: "typo" })).toBe(DEFAULT_LOG_LEVEL); // invalid explicit ignored
    expect(resolveLogLevel()).toBe(DEFAULT_LOG_LEVEL); // no signals at all
  });
});

describe("extractLogOptions (#4835)", () => {
  it("peels --verbose off and leaves the command args untouched", () => {
    const { options, rest } = extractLogOptions(["--verbose", "discover", "acme/repo", "--json"]);
    expect(options).toEqual({ quiet: false, verbose: true, level: undefined });
    expect(rest).toEqual(["discover", "acme/repo", "--json"]);
  });

  it("supports --quiet and both --log-level spellings", () => {
    expect(extractLogOptions(["--quiet"]).options).toEqual({ quiet: true, verbose: false, level: undefined });
    expect(extractLogOptions(["--log-level", "warn", "status"])).toEqual({
      options: { quiet: false, verbose: false, level: "warn" },
      rest: ["status"],
    });
    expect(extractLogOptions(["--log-level=silent", "status"]).options.level).toBe("silent");
  });

  it("tolerates a trailing --log-level with no value and an empty argv", () => {
    expect(extractLogOptions(["--log-level"]).options.level).toBeUndefined();
    expect(extractLogOptions([])).toEqual({
      options: { quiet: false, verbose: false, level: undefined },
      rest: [],
    });
  });
});

describe("formatFields (#4835)", () => {
  it("returns empty for nullish or all-undefined field sets", () => {
    expect(formatFields(undefined)).toBe("");
    expect(formatFields(null)).toBe("");
    expect(formatFields({ a: undefined })).toBe("");
  });

  it("sorts keys, drops undefined, and quotes only whitespace-bearing strings", () => {
    expect(formatFields({ b: 2, a: "x", c: "two words", d: undefined })).toBe(' a=x b=2 c="two words"');
  });
});

describe("formatLine (#4835)", () => {
  it("plain mode is just the message plus any field suffix", () => {
    expect(formatLine({ level: "info", message: "hi" })).toBe("hi");
    expect(formatLine({ level: "info", message: "hi", fields: { a: 1 } })).toBe("hi a=1");
  });

  it("pretty mode adds an uppercased level tag and an optional timestamp", () => {
    expect(
      formatLine({ level: "warn", message: "hi", pretty: true, timestamp: "2026-01-01T00:00:00Z" }),
    ).toBe("[2026-01-01T00:00:00Z] WARN hi");
    expect(formatLine({ level: "warn", message: "hi", pretty: true })).toBe("WARN hi");
  });
});

describe("createLogger level gating + routing (#4835)", () => {
  it("emits methods at or below the active level and suppresses the rest", () => {
    const { out, err, streams } = capture();
    const logger = createLogger({ level: "warn", streams });
    logger.error("e");
    logger.warn("w");
    logger.info("i");
    logger.debug("d");
    expect(err).toEqual(["e\n", "w\n"]); // error + warn go to stderr
    expect(out).toEqual([]); // info + debug suppressed at the warn threshold
    expect(logger.level).toBe("warn");
    expect(logger.isLevelEnabled("warn")).toBe(true);
    expect(logger.isLevelEnabled("info")).toBe(false);
  });

  it("routes info/debug to stdout when the level is verbose enough", () => {
    const { out, err, streams } = capture();
    const logger = createLogger({ level: "debug", streams });
    logger.info("i");
    logger.debug("d");
    expect(out).toEqual(["i\n", "d\n"]);
    expect(err).toEqual([]);
  });
});

describe("createLogger fields + child (#4835)", () => {
  it("emits no field suffix when neither base nor call-site fields are present", () => {
    const { out, streams } = capture();
    createLogger({ streams }).info("plain");
    expect(out).toEqual(["plain\n"]);
  });

  it("merges call-site fields onto the line", () => {
    const { out, streams } = capture();
    createLogger({ streams }).info("m", { a: 1 });
    expect(out).toEqual(["m a=1\n"]);
  });

  it("child loggers merge base fields with their own", () => {
    const { out, streams } = capture();
    const child = createLogger({ streams, fields: { run: "r1" } }).child({ step: 2 });
    child.info("c");
    expect(out).toEqual(["c run=r1 step=2\n"]);
  });
});

describe("createLogger pretty timestamps (#4835)", () => {
  it("uses the injected clock in pretty mode", () => {
    const { err, streams } = capture();
    createLogger({ level: "error", pretty: true, streams, now: () => "T0" }).error("boom");
    expect(err).toEqual(["[T0] ERROR boom\n"]);
  });

  it("falls back to the default ISO clock when no clock is injected", () => {
    const { err, streams } = capture();
    createLogger({ level: "error", pretty: true, streams }).error("boom");
    expect(err[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] ERROR boom\n$/);
  });
});

describe("createLogger env + default streams (#4835)", () => {
  it("reads GITTENSORY_MINER_LOG_LEVEL when no explicit level is given", () => {
    const { out, err, streams } = capture();
    const logger = createLogger({ env: { GITTENSORY_MINER_LOG_LEVEL: "debug" }, streams });
    expect(logger.level).toBe("debug");
    logger.debug("d");
    expect(out).toEqual(["d\n"]);
    expect(err).toEqual([]);
  });

  it("ignores an empty env and falls back to real stdout when no streams are injected", () => {
    expect(createLogger({ env: {} }).level).toBe(DEFAULT_LOG_LEVEL);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    createLogger({}).info("to real stdout"); // default env (process.env) + default streams
    expect(write).toHaveBeenCalledWith("to real stdout\n");
  });
});

describe("process logger singleton (#4835)", () => {
  it("configureLogger swaps the shared instance returned by getLogger", () => {
    const before = getLogger();
    const configured = configureLogger({ level: "debug" });
    expect(getLogger()).toBe(configured);
    expect(getLogger()).not.toBe(before);
    expect(getLogger().level).toBe("debug");
  });
});
