import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bin, run } from "./support/mcp-cli-harness";

// #8691: bin/loopover-mcp.ts attaches no "error" listener to process.stdout/stderr, so a broken pipe
// (EPIPE — the downstream reader in `... | head` closes after a few bytes, while the CLI is still writing a
// large payload) surfaced as an uncaught `Error: write EPIPE` and crashed the whole CLI with a stack trace
// instead of exiting cleanly. `tools` is a deterministic, offline, large (~27KB, many separate writes)
// payload — piping it into a reader that grabs a handful of bytes and exits reliably reproduces the race.
// These tests spawn the real compiled dist CLI (like the rest of the mcp-cli-*.test.ts harness), so they
// require `npm run build:mcp` to have run first — CI's "Build MCP" step and local `npm run test:ci` do that.

const configEnv = () => ({ ...process.env, LOOPOVER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "loopover-cli-brokenpipe-")) });

/** Spawn `loopover-mcp tools` with its stdout wired straight into `head`'s stdin (a real OS pipe), so when
 *  head reads a few bytes and exits the CLI's next write hits a closed pipe — exactly the `| head` scenario.
 *  Resolves the CLI's own exit code/signal plus its stderr (where an uncaught-exception crash would print). */
function runPipedIntoEarlyClosingReader(): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const reader = spawn("head", ["-c", "5"], { stdio: ["pipe", "ignore", "ignore"] });
    // The parent-side handle to head's stdin can emit its own EPIPE once head exits; it is irrelevant to what
    // the CLI subprocess sees, so swallow it rather than let it reject the test's own process.
    reader.stdin.on("error", () => {});
    const cli = spawn(process.execPath, [bin, "tools"], { stdio: ["ignore", reader.stdin, "pipe"], env: configEnv() });
    let stderr = "";
    cli.stderr.on("data", (chunk) => (stderr += chunk));
    cli.on("error", reject);
    cli.on("exit", (code, signal) => {
      if (!reader.killed) reader.kill();
      resolve({ code, signal, stderr });
    });
  });
}

describe("loopover-mcp CLI survives a broken pipe (#8691)", () => {
  it("exits cleanly — not via an uncaught EPIPE crash — when its large output is piped into a reader that closes early", async () => {
    const { code, signal, stderr } = await runPipedIntoEarlyClosingReader();
    // Clean exit: a documented exit code, not a signal-kill, and no uncaught-exception stack trace on stderr.
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/EPIPE/);
    expect(stderr).not.toMatch(/Unhandled 'error'/);
    expect(stderr).not.toMatch(/at afterWriteDispatched/);
  }, 15_000);

  it("leaves normal (fully-drained) command output unaffected", () => {
    // The same command read to completion still emits its full, unchanged output and exits successfully — the
    // new error listener must not perturb the ordinary, non-broken-pipe path.
    const output = run(["tools"]);
    expect(output).toMatch(/Discovery & planning/);
    expect(output).toContain("loopover_local_status");
    expect(output.length).toBeGreaterThan(10_000);
  });
});
