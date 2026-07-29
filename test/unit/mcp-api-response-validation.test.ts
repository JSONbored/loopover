import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #9521/#9519: the response-validation boundary, driven against a server that answers a validated path with
// a body the published schema rejects.
//
// The posture #9519 recorded is specific and this pins both halves of it: "failures logged + captured as
// errors, never 500ing an otherwise-good response". So the default is a stderr warning and the payload comes
// back UNTOUCHED — returning `parsed.data` would strip every key the document does not yet declare, which is
// exactly the silent data loss the validation exists to prevent. `LOOPOVER_VALIDATE_RESPONSES` opts into the
// throwing half that CI and the self-host container run with.

type BinModule = { runCli: (args: string[]) => Promise<number | void> };

const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
// A validated path whose named 200 schema has REQUIRED fields (LocalBranchAnalysis declares 26), answered
// here with `{}`. Several validated responses declare everything optional, so `{}` satisfies them — picking
// one of those would have made this test pass while proving nothing.
const VIOLATING_PATH = "/v1/local/branch-analysis";
/** Answers `{}` so the watch renderer meets a payload with NO `watching` key at all. */
const EMPTY_WATCHES_PATH = "/v1/contributors/JSONbored/watches";
/** Answers HTML on a 200, so the parse failure is a genuine failure rather than a degradable error body. */
const NON_JSON_PATH = "/v1/lint/issue-slop";
/** Answers a JSON array: valid JSON, wrong top-level type, so the first issue carries an EMPTY path. */
const ROOT_TYPE_PATH = "/v1/lint/improvement-potential";

let sharedConfigDir = "";
let mod: BinModule;

beforeAll(async () => {
  sharedConfigDir = mkdtempSync(join(tmpdir(), "loopover-response-validation-"));
  const apiUrl = await startFixtureServer({ schemaViolationPaths: [VIOLATING_PATH, EMPTY_WATCHES_PATH], nonJsonOkPaths: [NON_JSON_PATH], rootTypeViolationPaths: [ROOT_TYPE_PATH], labellessWatch: true, openPrMonitor: { summary: undefined } });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_NPM_REGISTRY_URL = apiUrl;
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = sharedConfigDir;
  process.env.LOOPOVER_TOKEN = "test-token";
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (sharedConfigDir) rmSync(sharedConfigDir, { recursive: true, force: true });
  for (const key of ["LOOPOVER_API_URL", "LOOPOVER_NPM_REGISTRY_URL", "LOOPOVER_API_TIMEOUT_MS", "LOOPOVER_CONFIG_DIR", "LOOPOVER_TOKEN"]) {
    delete process.env[key];
  }
});

afterEach(() => {
  delete process.env.LOOPOVER_VALIDATE_RESPONSES;
});

function captureStderr(): { read: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return { read: () => chunks.join(""), restore: () => spy.mockRestore() };
}

async function silently(fn: () => Promise<unknown>): Promise<void> {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await fn();
  } finally {
    stdout.mockRestore();
  }
}

describe("response validation reports rather than rejects (#9521)", () => {
  it("warns on stderr naming the endpoint and the first offending field, and still completes", async () => {
    const stderr = captureStderr();
    try {
      // The command SUCCEEDS: an otherwise-good response is never turned into a failure.
      await silently(() => mod.runCli(["analyze-branch", "--login", "octocat", "--repo", "owner/repo", "--json"]));
    } finally {
      stderr.restore();
    }
    const warning = stderr.read();
    expect(warning).toContain("warning:");
    expect(warning, "the endpoint must be named so an operator knows which contract broke").toContain(VIOLATING_PATH);
    expect(warning, "the first offending field's path must be named").toMatch(/: \S+ —/);
  });

  it("warns ONCE per path, so a polling loop cannot flood stderr", async () => {
    const stderr = captureStderr();
    try {
      await silently(() => mod.runCli(["analyze-branch", "--login", "octocat", "--repo", "owner/repo", "--json"]));
      await silently(() => mod.runCli(["analyze-branch", "--login", "octocat", "--repo", "other/repo", "--json"]));
    } finally {
      stderr.restore();
    }
    const occurrences = stderr.read().split(VIOLATING_PATH).length - 1;
    expect(occurrences, "the memo must suppress the repeat").toBeLessThanOrEqual(1);
  });

  it("THROWS instead when LOOPOVER_VALIDATE_RESPONSES opts in — the CI/self-host half of the posture", async () => {
    process.env.LOOPOVER_VALIDATE_RESPONSES = "true";
    await expect(silently(() => mod.runCli(["analyze-branch", "--login", "octocat", "--repo", "owner/repo", "--json"]))).rejects.toThrow(
      /did not match the published schema/,
    );
  });

  it("leaves a well-formed response alone — validation is not a filter", async () => {
    // slop-risk is validated too and its fixture IS well-formed; no warning, and the payload renders.
    const stderr = captureStderr();
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    try {
      await mod.runCli(["slop-risk", "--description", "adds a feature"]);
    } finally {
      stdout.mockRestore();
      stderr.restore();
    }
    expect(stderr.read()).not.toContain("did not match the published schema");
    expect(output).toContain("Slop risk:");
  });
});

describe("renderers survive a payload with every optional field absent (#9521)", () => {
  it("watch list renders an empty roster rather than throwing on a missing `watching`", async () => {
    // The `?? []` arms exist for exactly this: the document declares these optional, so a response without
    // them is legal and must render, not crash.
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    const stderr = captureStderr();
    try {
      await mod.runCli(["watch", "list", "--login", "JSONbored"]);
    } finally {
      stdout.mockRestore();
      stderr.restore();
    }
    expect(output).toContain("Watching 0 repo(s)");
  });
});

describe("a 200 whose body will not parse is a real failure (#9521)", () => {
  it("rethrows the parse error rather than inventing a structured error body", async () => {
    // The degraded `{ error: "non_json_response" }` shape is for NON-OK responses, where the body is
    // already an error. On a 200 the caller asked for data and got garbage — that must not look like success.
    await expect(silently(() => mod.runCli(["issue-slop", "--title", "t", "--body", "b"]))).rejects.toThrow();
  });
});

describe("the mismatch report degrades when the issue has no field path (#9521)", () => {
  it('names "(root)" for a top-level type error rather than printing an empty field', async () => {
    // A response that is valid JSON but the wrong SHAPE at the top level produces an issue with an empty
    // `path`. Joining that would print nothing where the field name belongs.
    const stderr = captureStderr();
    try {
      await silently(() => mod.runCli(["improvement-potential", "--changed-file", "src/a.ts:10:2"])).catch(() => undefined);
    } finally {
      stderr.restore();
    }
    expect(stderr.read()).toContain(`${ROOT_TYPE_PATH}: (root)`);
  });
});

describe("renderers fall back when an optional field the API usually sends is absent (#9521)", () => {
  it("the open-PR monitor writes its own sentence when the API sends no summary", async () => {
    // The CLI mirrors the API's `summary` when there is one, so the two surfaces never drift into two
    // sentences for one payload; this is the other arm, where there is nothing to mirror.
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    try {
      await mod.runCli(["monitor-open-prs", "--login", "JSONbored"]);
    } finally {
      stdout.mockRestore();
    }
    expect(output).toContain("LoopOver open-PR monitor for JSONbored.");
  });

  it("watch list renders an entry that carries no labels key at all", async () => {
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    try {
      await mod.runCli(["watch", "list", "--login", "someone-else"]);
    } finally {
      stdout.mockRestore();
    }
    expect(output).toContain("acme/widgets");
  });
});
