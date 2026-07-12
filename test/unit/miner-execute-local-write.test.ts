import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeLocalWrite } from "../../packages/gittensory-miner/lib/execute-local-write.js";

function spec(command: string, action = "open_pr") {
  return { action, description: "test spec", inputs: {}, command, boundary: "boundary text" };
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("executeLocalWrite (#5132)", () => {
  it("captures stdout and a zero exit code from a real short-lived command", async () => {
    const result = await executeLocalWrite(spec("printf hello"));
    expect(result).toEqual({ action: "open_pr", stdout: "hello", stderr: "", code: 0, timedOut: false });
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await executeLocalWrite(spec("echo oops 1>&2; exit 2"));
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("oops\n");
    expect(result.timedOut).toBe(false);
  });

  it("resolves (never rejects) with code:null when the shell itself cannot be spawned", async () => {
    const result = await executeLocalWrite(spec("echo hi"), { cwd: "/definitely/does/not/exist/xyz" });
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("kills a long-lived command and resolves with timedOut:true when the timeout elapses", async () => {
    const result = await executeLocalWrite(spec("sleep 5"), { timeoutMs: 100 });
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(true);
  });

  it("runs in the given working directory and inherits the given env", async () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-execute-local-write-"));
    roots.push(root);
    const resolvedRoot = realpathSync(root);
    const result = await executeLocalWrite(spec("pwd"), { cwd: resolvedRoot, env: { ...process.env, PATH: process.env.PATH ?? "" } });
    expect(result.stdout.trim()).toBe(resolvedRoot);
    expect(result.code).toBe(0);
  });

  it("preserves the spec's action in the result", async () => {
    const result = await executeLocalWrite(spec("true", "file_issue"));
    expect(result.action).toBe("file_issue");
  });
});
