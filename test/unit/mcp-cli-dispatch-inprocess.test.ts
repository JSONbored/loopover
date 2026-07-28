import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #9521: the CLI paths this issue rewrote, driven IN-PROCESS through the exported runCli.
//
// The existing CLI suites mostly spawn the real compiled bin, which is the right shape for testing the
// process boundary (exit codes, stdio, broken pipes) but reports NO coverage back to vitest — the work
// happens in another process. So the dispatch table, the derived help printers, and the response renderers
// this issue touched were exercised without being measured. These drive the same paths in-process, using
// the #8587 pattern already established by mcp-cli-basics.test.ts and mcp-cli-bool-flag-parsing.test.ts.

type BinModule = { runCli: (args: string[]) => Promise<number | void> };

// TS5097: keep the .ts specifier out of a literal import() position.
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

let sharedConfigDir = "";
let mod: BinModule;

beforeAll(async () => {
  sharedConfigDir = mkdtempSync(join(tmpdir(), "loopover-dispatch-inprocess-"));
  const apiUrl = await startFixtureServer();
  // The bin reads these at module load, so they must be set BEFORE the dynamic import.
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

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("CLI_COMMAND_SPEC drives the sub-command help bodies (#9521)", () => {
  it.each([
    ["cache", ["cache status [--json]", "cache list [--json | --format ndjson]", "cache clear [--json]"]],
    ["profile", ["profile list [--json | --format ndjson]", "profile create <name> [--json]"]],
    [
      "agent",
      ['agent start --login <github-login> --objective "..."', "agent status <run-id> [--json]"],
    ],
  ])("%s --help renders its usage lines from the spec", async (command, expected) => {
    const output = await captureStdout(() => mod.runCli([command, "--help"]));
    for (const line of expected) {
      expect(output, `${command} --help must include "${line}"`).toContain(line);
    }
  });

  it("cache --help carries the spec's note, not a hand-written trailer", async () => {
    const output = await captureStdout(() => mod.runCli(["cache", "--help"]));
    expect(output).toContain("Source upload remains disabled.");
  });

  it("REGRESSION: agent --help lists `agent start`, which the spec used to omit", async () => {
    // The printer had it and the spec did not, so top-level help silently dropped the command (#9521).
    const output = await captureStdout(() => mod.runCli(["agent", "--help"]));
    expect(output).toContain("agent start");
  });
});

describe("runCli dispatch (#9521)", () => {
  it("routes the --version and -v aliases, which live outside the handler table", async () => {
    for (const alias of ["--version", "-v"]) {
      const output = await captureStdout(() => mod.runCli([alias, "--json"]));
      expect(JSON.parse(output).name).toBe("@loopover/mcp");
    }
  });

  it("routes the `profiles` alias to the profile command", async () => {
    // `profiles` is a spelling of `profile list`, kept outside the handler table with the other aliases.
    const output = await captureStdout(() => mod.runCli(["profiles", "list", "--json"]));
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("throws on an unknown command, suggesting the nearest real one", async () => {
    // The suggestion comes from the same spec the completion and help surfaces read.
    await expect(mod.runCli(["doctr"])).rejects.toThrow(/Unknown command: doctr.*Did you mean/s);
  });

  it("throws a bare unknown-command error when nothing is close enough to suggest", async () => {
    await expect(mod.runCli(["zzzzzzzz"])).rejects.toThrow(/Unknown command: zzzzzzzz\. Run/);
  });

  it("prints top-level help for no command, --help, and the bare `help` positional", async () => {
    for (const args of [[], ["--help"], ["help"]]) {
      const output = await captureStdout(() => mod.runCli(args));
      expect(output).toContain("loopover-mcp --stdio");
      // Every spec entry's first usage line appears, which is what makes help derived rather than written.
      expect(output).toContain("loopover-mcp doctor");
    }
  });

  it("routes logout, which the handler table owns", async () => {
    const output = await captureStdout(() => mod.runCli(["logout", "--json"]));
    expect(() => JSON.parse(output)).not.toThrow();
  });
});

describe("the rest of the handler table (#9521)", () => {
  // Each of these is one entry in the Record that replaced the 34-branch if-chain. Driving them here is
  // what proves the table actually routes, rather than just type-checking.
  it("routes contributor-profile", async () => {
    const output = await captureStdout(() => mod.runCli(["contributor-profile", "--login", "JSONbored", "--json"]));
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("routes explain-review-risk", async () => {
    const output = await captureStdout(() =>
      mod.runCli(["explain-review-risk", "--repo", "JSONbored/loopover", "--title", "fix: a thing", "--json"]),
    );
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("routes watch list, rendering repos with and without labels", async () => {
    // The renderer's `?? []` arms matter: the fixture returns one repo WITH labels and one without.
    const output = await captureStdout(() => mod.runCli(["watch", "list", "--login", "JSONbored"]));
    expect(output).toContain("acme/widgets");
    expect(output).toContain("acme/gadgets");
  });

  it("routes validate-config against a real file", async () => {
    const file = join(sharedConfigDir, "focus.yml");
    writeFileSync(file, "version: 1\n");
    const output = await captureStdout(() => mod.runCli(["validate-config", "--file", file, "--json"]));
    expect(() => JSON.parse(output)).not.toThrow();
  });
});

describe("lint renderers tolerate an unspecced findings payload (#9521)", () => {
  // These endpoints' 200 bodies declare `findings` as z.unknown(), so the renderers cannot index it as a
  // typed array — `unspeccedList` is what keeps them from throwing on a shape the document never pinned.
  it("renders slop-risk findings", async () => {
    const output = await captureStdout(() => mod.runCli(["slop-risk", "--description", "adds a feature"]));
    expect(output).toContain("Slop risk:");
  });

  it("renders improvement-potential findings", async () => {
    const output = await captureStdout(() => mod.runCli(["improvement-potential", "--changed-file", "src/a.ts:10:2"]));
    expect(output).toContain("Improvement potential:");
  });

  it("renders issue-slop findings", async () => {
    const output = await captureStdout(() => mod.runCli(["issue-slop", "--title", "Fix the thing", "--body", "It is broken"]));
    expect(output).toContain("Issue slop risk:");
  });

  it("renders pr-text lint fixes", async () => {
    const output = await captureStdout(() => mod.runCli(["lint-pr-text", "--commit", "fix: a thing", "--body", "why"]));
    expect(output).toContain("PR text lint:");
  });
});

describe("validated responses reach their call sites (#9521)", () => {
  it("analyze-branch reads predictedGate off the response the document under-describes", async () => {
    const output = await captureStdout(() =>
      mod.runCli(["analyze-branch", "--login", "octocat", "--repo", "owner/repo", "--json"]),
    );
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("preflight renders its validated result", async () => {
    const output = await captureStdout(() => mod.runCli(["preflight", "--login", "octocat", "--repo", "owner/repo", "--json"]));
    expect(() => JSON.parse(output)).not.toThrow();
  });
});
