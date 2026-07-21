import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7764: in-process coverage for the `maintain plan-issues` CLI dispatcher AND the loopover_plan_repo_issues
// stdio tool in packages/loopover-mcp/bin/loopover-mcp.ts. The bin dispatcher/stdio server is otherwise only
// exercised via subprocess spawn (mcp-cli-*.test.ts), which v8 cannot instrument -- the #7764 entrypoint guard
// (isProcessEntrypoint) is what lets a test import the module without it hijacking the runner's argv or binding
// stdin, so these new lines get real Codecov-measured coverage. Both the committed .js and its .ts source are
// exercised (each is a separately graded coverage.include entry) by importing both and running every path.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.js", "../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  maintainCli: (args: string[]) => Promise<void>;
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const planRequests: Array<{ goal?: string; dryRun?: boolean; create?: boolean; limit?: number }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-plan-issues-"));
  const apiUrl = await startFixtureServer({ onPlanIssuesRequest: (body) => planRequests.push(body) });
  // The bin reads LOOPOVER_API_URL at module load, so set the env BEFORE importing (hence the dynamic import).
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  for (const specifier of MODULES) {
    loaded.set(specifier, (await import(specifier)) as unknown as BinModule);
  }
});

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
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

describe("bin maintain plan-issues CLI (in-process, #7764)", () => {
  it.each(MODULES)("previews drafts (dry-run) and sanitizes the AI title — %s", async (specifier) => {
    planRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["plan-issues", "--repo", "owner/repo", "--goal", "Improve docs", "--limit", "4"]));
    expect(planRequests[0]).toMatchObject({ goal: "Improve docs", create: false, dryRun: true, limit: 4 });
    expect(out).toMatch(/Issue plan for owner\/repo \(dry-run, status=ok\): 1 proposed, 0 created/);
    expect(out).toContain("Add cursor pagination");
    expect(out).not.toContain("[31m");
  });

  it.each(MODULES)("--create forwards {create:true, dryRun:false} and reports the created issue ref — %s", async (specifier) => {
    planRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["plan-issues", "--repo", "owner/repo", "--goal", "Ship it", "--create"]));
    expect(planRequests[0]).toMatchObject({ goal: "Ship it", create: true, dryRun: false });
    expect(out).toMatch(/\(create, status=ok\): 0 proposed, 1 created/);
    expect(out).toMatch(/#51 https:\/\/github\.com\/owner\/repo\/issues\/51/);
  });

  it.each(MODULES)("emits machine-readable JSON with --json — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["plan-issues", "--repo", "owner/repo", "--goal", "x", "--json"]));
    const payload = JSON.parse(out) as { status: string; dryRun: boolean; proposed: number };
    expect(payload).toMatchObject({ status: "ok", dryRun: true, proposed: 1 });
  });

  it.each(MODULES)("rejects a missing --goal before any request — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    await expect(mod.maintainCli(["plan-issues", "--repo", "owner/repo"])).rejects.toThrow(/planning goal/);
  });

  it.each(MODULES)("falls through past plan-issues to the unknown-subcommand error — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    // Exercises the false side of `subcommand === "plan-issues"` and the updated unknown-subcommand throw.
    await expect(mod.maintainCli(["not-a-real-subcommand", "--repo", "owner/repo"])).rejects.toThrow(/Unknown maintain subcommand.*plan-issues/);
  });

  it.each(MODULES)("falls back to zero counts and no draft lines on a countless posture — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    // "__bare__" makes the fixture return a disabled posture with no counts/drafts, exercising the CLI's
    // defensive `?? 0` / `?? []` fallbacks (a real `disabled`/`unavailable` short-circuit has no counts).
    const out = await captureStdout(() => mod.maintainCli(["plan-issues", "--repo", "owner/repo", "--goal", "__bare__"]));
    expect(out).toMatch(/status=disabled\): 0 proposed, 0 created, 0 duplicate, 0 declined, 0 unsafe, 0 create-failed\./);
    expect(out).not.toContain("- [");
  });

  it.each(MODULES)("documents plan-issues in the maintain --help output — %s", async (specifier) => {
    // Covers printMaintainHelp's new plan-issues entry (#7764) and guards the command staying documented.
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["--help"]));
    expect(out).toContain('plan-issues --goal "..."');
    expect(out).toContain("AI-plan issue drafts from a free-form goal");
  });
});

describe("bin loopover_plan_repo_issues stdio tool (in-process, #7764)", () => {
  it.each(MODULES)("proxies the plan route and returns the counts + posture — %s", async (specifier) => {
    planRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "plan-repo-issues-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "loopover_plan_repo_issues",
        arguments: { owner: "owner", repo: "repo", goal: "Improve docs" },
      });
      expect(result.isError).toBeFalsy();
      expect(planRequests[0]).toMatchObject({ goal: "Improve docs", dryRun: true, create: false });
      expect(result.structuredContent).toMatchObject({ repoFullName: "owner/repo", status: "ok", dryRun: true, proposed: 1 });

      // A countless (disabled) posture exercises the summary's defensive `?? 0` fallbacks.
      const bare = await client.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "owner", repo: "repo", goal: "__bare__" } });
      expect(bare.isError).toBeFalsy();
      const bareText = (bare.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(bareText).toMatch(/status=disabled, dryRun=true\): 0 proposed, 0 created\./);
    } finally {
      await client.close();
    }
  });
});
