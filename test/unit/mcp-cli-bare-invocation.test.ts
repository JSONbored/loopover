import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { run } from "./support/mcp-cli-harness";

// #8313: a bare `loopover-mcp` (zero arguments) used to fall through the CLI-dispatch gate at
// packages/loopover-mcp/bin/loopover-mcp.ts:1645 (guarded on `cliArgs[0]` being truthy) and reach the
// unconditional StdioServerTransport bind, silently starting the MCP stdio server and hanging on a plain
// terminal. The fix (1) relaxes that entry gate so a zero-arg invocation reaches `runCli([])`, and (2) adds a
// `command === undefined` case to runCli's existing `--help`/`help` branch so bare invocation prints the usage
// banner and exits 0.
//
// The entry-gate line itself only runs in the launched process (runAsCliEntrypoint) and is v8-ignored, so this
// file covers the two observable contracts: the in-process test drives runCli directly so Codecov attributes the
// new `command === undefined` branch (a subprocess spawn is invisible to v8 coverage, per mcp-cli-plan-issues),
// and the subprocess test proves the real end-to-end behavior — bare invocation exits promptly with the banner
// rather than binding stdio and hanging.

const MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

type BinModule = {
  runCli: (args: string[]) => Promise<number | void>;
};

let tempDir = "";
let bin: BinModule;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-bare-invocation-"));
  // Keep module load offline/deterministic, matching the other in-process bin importers.
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_API_TIMEOUT_MS = "1000";
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  bin = (await import(MODULE)) as unknown as BinModule;
});

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

async function captureStdout(fn: () => Promise<number | void>): Promise<string> {
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

describe("bare loopover-mcp invocation prints usage help instead of starting the stdio server (#8313)", () => {
  it("routes runCli([]) (zero args) to the same usage banner as --help and help, in-process", async () => {
    // runCli([]) exercises the new `command === undefined` operand; ["--help"] and ["help"] exercise the two
    // pre-existing operands of the same branch, so every operand of the changed condition is evaluated true.
    const bare = await captureStdout(() => bin.runCli([]));
    const dashHelp = await captureStdout(() => bin.runCli(["--help"]));
    const help = await captureStdout(() => bin.runCli(["help"]));

    expect(bare).toMatch(/^Usage:/);
    expect(bare).toMatch(/loopover-mcp --stdio/);
    // A bare invocation must produce byte-identical output to --help and help — that is the contract.
    expect(bare).toBe(dashHelp);
    expect(bare).toBe(help);
  });

  it("does not divert a real command to help — the new undefined check only matches zero args", async () => {
    // Drives the changed condition's false path (`version` is defined and is neither --help nor help), so the
    // help branch falls through to normal dispatch instead of printing the usage banner.
    const versionOutput = await captureStdout(() => bin.runCli(["version"]));

    expect(versionOutput).toMatch(/@loopover\/mcp\//);
    expect(versionOutput).not.toMatch(/^Usage:/);
  });

  it("exits 0 without hanging and prints the same banner as --help when spawned with no arguments", () => {
    // execFileSync returns stdout only on exit 0; a non-zero exit or a hang would throw/time out instead.
    const bare = run([]);
    const dashHelp = run(["--help"]);

    expect(bare).toMatch(/^Usage:/);
    expect(bare).toMatch(/loopover-mcp --stdio/);
    expect(bare).toBe(dashHelp);
  });
});
