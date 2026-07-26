import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { bin } from "./support/mcp-cli-harness";

// TS5097: keep the .ts specifier out of a literal import() position.
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

describe("stdio EPIPE handlers (#8691)", () => {
  it("installStdioErrorHandlers exits cleanly when stdout or stderr emits an error", async () => {
    const { installStdioErrorHandlers } = (await import(BIN_MODULE)) as {
      installStdioErrorHandlers: (
        stdout?: EventEmitter,
        stderr?: EventEmitter,
        exitProcess?: (code: number) => void,
      ) => void;
    };

    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exitProcess = vi.fn();
    installStdioErrorHandlers(stdout, stderr, exitProcess);

    stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exitProcess).toHaveBeenCalledWith(1);

    exitProcess.mockClear();
    stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exitProcess).toHaveBeenCalledWith(1);

    exitProcess.mockClear();
    stdout.emit("error", Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" }));
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("keeps normal version --json output unaffected", () => {
    const stdout = spawn(process.execPath, [bin, "version", "--json"], {
      env: {
        ...process.env,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "1",
        LOOPOVER_API_TIMEOUT_MS: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      stdout.stdout?.on("data", (c) => chunks.push(c));
      stdout.stderr?.on("data", (c) => errChunks.push(c));
      stdout.on("error", reject);
      stdout.on("close", (code) => {
        try {
          expect(code).toBe(0);
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: string; version: string };
          expect(payload.name).toBeTruthy();
          expect(payload.version).toBeTruthy();
          expect(Buffer.concat(errChunks).toString("utf8")).not.toMatch(/EPIPE|uncaught/i);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  it("exits cleanly when a large tools --json payload is piped into an early-closing reader", () => {
    // Real broken-pipe scenario: CLI writes a large JSON list; consumer reads one chunk then exits,
    // closing the pipe. Without the error listener this crashes with uncaught EPIPE.
    const cli = spawn(process.execPath, [bin, "tools", "--json"], {
      env: {
        ...process.env,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "1",
        LOOPOVER_API_TIMEOUT_MS: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const consumer = spawn(
      process.execPath,
      ["-e", "process.stdin.once('data', () => process.exit(0)); process.stdin.resume();"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    cli.stdout?.pipe(consumer.stdin!);

    return new Promise<void>((resolve, reject) => {
      const errChunks: Buffer[] = [];
      cli.stderr?.on("data", (c) => errChunks.push(c));
      const timer = setTimeout(() => {
        cli.kill("SIGKILL");
        consumer.kill("SIGKILL");
        reject(new Error("CLI did not exit within timeout after broken pipe"));
      }, 15_000);
      cli.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      cli.on("close", (code, signal) => {
        clearTimeout(timer);
        try {
          // Clean exit (code set, no signal kill) — not an uncaught-exception abort.
          expect(signal).toBeNull();
          expect(code === 0 || code === 1).toBe(true);
          const errText = Buffer.concat(errChunks).toString("utf8");
          expect(errText).not.toMatch(/uncaughtException|Unhandled|write EPIPE/i);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
});
