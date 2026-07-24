import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #8314: in-process coverage for the `agent start` CLI subcommand in packages/loopover-mcp/bin/loopover-mcp.ts.
// Same #7764 entrypoint-guard pattern as mcp-cli-selftune-audit — import the committed .ts and call the
// exported runAgentCli directly, so v8/Codecov attributes the new branch (a subprocess-spawned CLI run is
// invisible to coverage).
const MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

type BinModule = { runAgentCli: (args: string[]) => Promise<void> };

let tempDir = "";
let mod: BinModule;
const capturedBodies: unknown[] = [];
let savedLoopoverLogin: string | undefined;
let savedGithubLogin: string | undefined;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-agent-start-"));
  const apiUrl = await startFixtureServer({ onAgentRunRequest: (body) => capturedBodies.push(body) });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  // The login-fallback reads these; unset them so the missing-login case throws deterministically.
  savedLoopoverLogin = process.env.LOOPOVER_LOGIN;
  savedGithubLogin = process.env.GITHUB_LOGIN;
  delete process.env.LOOPOVER_LOGIN;
  delete process.env.GITHUB_LOGIN;
  mod = (await import(MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  for (const key of ["LOOPOVER_API_URL", "LOOPOVER_API_TOKEN", "LOOPOVER_API_TIMEOUT_MS", "LOOPOVER_CONFIG_DIR", "LOOPOVER_SKIP_NPM_VERSION_CHECK"]) delete process.env[key];
  if (savedLoopoverLogin !== undefined) process.env.LOOPOVER_LOGIN = savedLoopoverLogin;
  if (savedGithubLogin !== undefined) process.env.GITHUB_LOGIN = savedGithubLogin;
});

beforeEach(() => {
  capturedBodies.length = 0;
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
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

describe("bin agent start CLI (in-process, #8314)", () => {
  it("posts the full run request with surface 'cli' and every target field mapped", async () => {
    await captureStdout(() =>
      mod.runAgentCli(["start", "--login", "octominer", "--objective", "Fix the flaky retry", "--repo", "acme/widgets", "--pull", "42", "--issue", "7"]),
    );
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toEqual({
      objective: "Fix the flaky retry",
      actorLogin: "octominer",
      surface: "cli",
      target: { repoFullName: "acme/widgets", pullNumber: 42, issueNumber: 7 },
    });
  });

  it("omits absent target fields entirely (stripUndefined leaves an empty target)", async () => {
    await captureStdout(() => mod.runAgentCli(["start", "--login", "octominer", "--objective", "Just start"]));
    expect(capturedBodies[0]).toEqual({
      objective: "Just start",
      actorLogin: "octominer",
      surface: "cli",
      target: {},
    });
  });

  it("emits the raw API payload under --json", async () => {
    const out = await captureStdout(() => mod.runAgentCli(["start", "--login", "octominer", "--objective", "Ship it", "--json"]));
    const payload = JSON.parse(out);
    expect(payload).toBeTypeOf("object");
    expect(capturedBodies[0]).toMatchObject({ actorLogin: "octominer", surface: "cli" });
  });

  it("throws a usage error when --login is missing (and no LOOPOVER_LOGIN/GITHUB_LOGIN)", async () => {
    await expect(mod.runAgentCli(["start", "--objective", "no login"])).rejects.toThrow(/Pass --login/);
    expect(capturedBodies).toHaveLength(0);
  });

  it("throws a usage error when --objective is missing", async () => {
    await expect(mod.runAgentCli(["start", "--login", "octominer"])).rejects.toThrow(/Pass --objective/);
    expect(capturedBodies).toHaveLength(0);
  });

  it("throws a usage error when --objective is passed without a value", async () => {
    await expect(mod.runAgentCli(["start", "--login", "octominer", "--objective"])).rejects.toThrow(/Pass --objective/);
    expect(capturedBodies).toHaveLength(0);
  });

  it("falls through the start check to the unknown-subcommand error for a non-start subcommand", async () => {
    await expect(mod.runAgentCli(["bogus"])).rejects.toThrow(/Unknown agent command: bogus/);
    expect(capturedBodies).toHaveLength(0);
  });

  it("documents `agent start` in the agent help output", async () => {
    const out = await captureStdout(() => mod.runAgentCli(["--help"]));
    expect(out).toContain("loopover-mcp agent start --login");
    expect(out).toContain('--objective "..."');
  });
});
