import { createServer, request as forwardToFixture, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
import {
  closeFixtureServer,
  createPacketRepo,
  decisionPackCacheFile,
  git,
  readDecisionPackCacheText,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #8587: converted from per-test subprocess spawns (run/runAsync) to one in-process import of the committed
// bin source, driving the exported runCli directly. LOOPOVER_API_URL and LOOPOVER_CONFIG_DIR are read at
// module load, so the whole file shares one fixture server (its per-request behavior stays configurable via
// the mutable `fixtureOptions` object the harness reads on every request) and one config dir (the cache
// subdir is wiped between tests, mirroring the fresh temp config dir each spawn used to get). The fixture
// server sits behind a tiny local proxy, and the proxy's port is what the bin sees: flipping `apiOnline`
// severs incoming requests, reproducing the "API unavailable" scenarios that previously worked by closing
// the per-test fixture server the subprocess pointed at.
type BinModule = { runCli: (args: string[]) => Promise<number | void> };

const fixtureOptions: {
  decisionPackStatus?: number;
  decisionPackErrorBody?: string;
  decisionPackErrorContentType?: string;
  repoDecisionStatus?: number;
  repoDecisionErrorBody?: string;
  repoDecisionErrorContentType?: string;
  packetMarkdown?: string;
  onPacketRequest?: (body: unknown) => void;
} = {};
const packetRequests: unknown[] = [];
let configDir = "";
let proxy: Server | null = null;
let apiOnline = true;
let mod: BinModule;

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

async function runCliJson(args: string[]): Promise<unknown> {
  return JSON.parse(await captureStdout(() => mod.runCli(args))) as unknown;
}

/** In-process equivalent of the harness's capturePacketValidation: same argv, same capture, no spawn. */
async function captureInProcessPacketValidation(repoDir: string, validationArgs: string[]) {
  packetRequests.length = 0;
  await captureStdout(() => mod.runCli(["agent", "packet", "--login", "oktofeesh1", "--cwd", repoDir, "--base", "HEAD", ...validationArgs, "--json"]));
  return (packetRequests[0] as { validation: Array<{ command: string; status: string; exitCode?: number; summary?: string }> }).validation;
}

describe("loopover-mcp CLI — packets", () => {
  let tempDir: string | null = null;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-cli-packets-inprocess-"));
    fixtureOptions.onPacketRequest = (body) => packetRequests.push(body);
    const fixtureUrl = new URL(await startFixtureServer(fixtureOptions));
    proxy = createServer((request, response) => {
      if (!apiOnline) {
        request.destroy();
        return;
      }
      const upstream = forwardToFixture(
        { hostname: fixtureUrl.hostname, port: fixtureUrl.port, path: request.url, method: request.method, headers: request.headers },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy?.listen(0, "127.0.0.1", () => resolve()));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");
    // The bin reads LOOPOVER_API_URL and LOOPOVER_CONFIG_DIR at module load, so set the env BEFORE importing.
    process.env.LOOPOVER_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.LOOPOVER_TOKEN = "session-token";
    process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
    process.env.LOOPOVER_CONFIG_DIR = configDir;
    process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
    mod = (await import(BIN_MODULE)) as unknown as BinModule;
  }, 120_000);

  afterAll(async () => {
    await closeFixtureServer();
    if (proxy) await new Promise<void>((resolve) => proxy?.close(() => resolve()));
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    delete process.env.LOOPOVER_API_URL;
    delete process.env.LOOPOVER_TOKEN;
    delete process.env.LOOPOVER_API_TIMEOUT_MS;
    delete process.env.LOOPOVER_CONFIG_DIR;
    delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    // Fresh decision-pack cache per test, standing in for the fresh temp config dir each subprocess got.
    if (configDir) rmSync(join(configDir, "cache"), { recursive: true, force: true });
    apiOnline = true;
    delete fixtureOptions.decisionPackStatus;
    delete fixtureOptions.decisionPackErrorBody;
    delete fixtureOptions.decisionPackErrorContentType;
    delete fixtureOptions.repoDecisionStatus;
    delete fixtureOptions.repoDecisionErrorBody;
    delete fixtureOptions.repoDecisionErrorContentType;
    delete fixtureOptions.packetMarkdown;
    packetRequests.length = 0;
    process.env.LOOPOVER_TOKEN = "session-token";
    delete process.env.LOOPOVER_API_TOKEN;
    delete process.env.LOOPOVER_MCP_TOKEN;
  });

  it("caches last-good decision packs and returns explicitly stale local fallback when the API is unavailable", async () => {
    const online = (await runCliJson(["decision-pack", "--login", "JSONbored", "--json"])) as { status: string; source: string };
    expect(online).toMatchObject({ status: "ready", source: "snapshot" });

    const cacheText = readDecisionPackCacheText(configDir);
    expect(cacheText).toMatch(/"authCacheKey":/);
    expect(cacheText).not.toContain("session-token");
    expect(cacheText).not.toMatch(/must stay local|wallet-value|hotkey-value|\/tmp\/source/i);

    apiOnline = false;

    const offline = (await runCliJson(["decision-pack", "--login", "JSONbored", "--json"])) as {
      source: string;
      stale: boolean;
      freshness: string;
      cachedAt: string;
      cache: { source: string; clearCommand: string; rerunGuidance: string };
    };
    expect(offline).toMatchObject({
      source: "local_cache",
      stale: true,
      freshness: "stale",
      cache: { source: "local_cache", clearCommand: "loopover-mcp cache clear" },
    });
    expect(offline.cachedAt).toEqual(expect.any(String));
    expect(offline.cache.rerunGuidance).toMatch(/Retry when LoopOver API access is restored/);

    const repoDecision = (await runCliJson(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/loopover", "--json"])) as {
      status: string;
      source: string;
      stale: boolean;
      decision: { repoFullName: string; recommendation: string };
    };
    expect(repoDecision).toMatchObject({
      status: "ready",
      source: "local_cache",
      stale: true,
      decision: { repoFullName: "JSONbored/loopover", recommendation: "pursue" },
    });
  });

  it("prints decision-pack help without requiring --login or making a network call", async () => {
    const help = await captureStdout(() => mod.runCli(["decision-pack", "--help"]));
    expect(help).toMatch(/Usage: loopover-mcp decision-pack/);
    expect(help).toMatch(/loopover_get_decision_pack/);
    expect(help).toMatch(/contributor decision pack/);
  });

  it("prints decision-pack help for a bare `help` positional too, not a --login error (#6257)", async () => {
    const help = await captureStdout(() => mod.runCli(["decision-pack", "help"]));
    expect(help).toMatch(/Usage: loopover-mcp decision-pack/);
    expect(help).not.toMatch(/Pass --login/);
  });

  it("prints repo-decision help without requiring --login/--repo or making a network call", async () => {
    const help = await captureStdout(() => mod.runCli(["repo-decision", "--help"]));
    expect(help).toMatch(/Usage: loopover-mcp repo-decision/);
    expect(help).toMatch(/loopover_explain_repo_decision/);
    expect(help).toMatch(/repo decision/);
  });

  it("prints repo-decision help for a bare `help` positional too, not a --login error (#6257)", async () => {
    const help = await captureStdout(() => mod.runCli(["repo-decision", "help"]));
    expect(help).toMatch(/Usage: loopover-mcp repo-decision/);
    expect(help).not.toMatch(/Pass --login/);
  });

  it("ignores incompatible decision-pack cache entries and clears cache entries on request", async () => {
    await runCliJson(["decision-pack", "--login", "JSONbored", "--json"]);
    const cachePath = decisionPackCacheFile(configDir);
    const entry = JSON.parse(readFileSync(cachePath, "utf8"));
    writeFileSync(cachePath, `${JSON.stringify({ ...entry, schemaVersion: 999 }, null, 2)}\n`, { mode: 0o600 });

    apiOnline = false;

    await expect(captureStdout(() => mod.runCli(["decision-pack", "--login", "JSONbored", "--json"]))).rejects.toThrow(
      /fetch failed|ECONNREFUSED|AbortError|aborted/i,
    );

    const cleared = (await runCliJson(["cache", "clear", "--json"])) as { status: string; removed: number };
    expect(cleared).toMatchObject({ status: "cleared", removed: 1 });
    const cacheStatus = (await runCliJson(["cache", "status", "--json"])) as { entries: number };
    expect(cacheStatus.entries).toBe(0);
  });

  it("lists cached decision packs with safe metadata only", async () => {
    const empty = (await runCliJson(["cache", "list", "--json"])) as { count: number; entries: unknown[] };
    expect(empty).toMatchObject({ count: 0, entries: [] });

    await runCliJson(["decision-pack", "--login", "JSONbored", "--json"]);
    const listed = (await runCliJson(["cache", "list", "--json"])) as {
      count: number;
      entries: Array<{ login: string; cachedAt: string; apiVersion: string; packageVersion: string; bytes: number }>;
    };
    expect(listed.count).toBe(1);
    const [first] = listed.entries;
    expect(first).toMatchObject({ login: "jsonbored", apiVersion: "0.1.0" });
    expect(first?.cachedAt).toEqual(expect.any(String));
    expect(first?.bytes).toBeGreaterThan(0);

    // Never leaks the token or the auth-cache key (a token hash).
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("session-token");
    expect(serialized).not.toMatch(/authCacheKey/);

    const human = await captureStdout(() => mod.runCli(["cache", "list"]));
    expect(human).toContain("jsonbored");
  });

  it("cache list --format ndjson streams one JSON object per cached entry", async () => {
    // Empty cache → zero ndjson lines (not a wrapper object).
    expect((await captureStdout(() => mod.runCli(["cache", "list", "--format", "ndjson"]))).trim()).toBe("");

    await runCliJson(["decision-pack", "--login", "JSONbored", "--json"]);
    const lines = (await captureStdout(() => mod.runCli(["cache", "list", "--format", "ndjson"]))).trim().split("\n");
    expect(lines).toHaveLength(1);
    const [firstLine] = lines as [string];
    const entry = JSON.parse(firstLine) as { login: string; bytes: number };
    expect(entry).toMatchObject({ login: "jsonbored" });
    expect(entry.bytes).toBeGreaterThan(0);
    // Each line is a bare entry, not the {count, entries} wrapper.
    expect(firstLine).not.toContain('"count"');
  });

  it("does not use stale decision-pack cache created by a different local token", async () => {
    await runCliJson(["decision-pack", "--login", "JSONbored", "--json"]);
    fixtureOptions.decisionPackStatus = 429;
    process.env.LOOPOVER_TOKEN = "different-session-token";

    await expect(captureStdout(() => mod.runCli(["decision-pack", "--login", "JSONbored", "--json"]))).rejects.toThrow(/LoopOver API 429/);
  });

  it("does not use stale decision-pack cache for authorization failures", async () => {
    await runCliJson(["decision-pack", "--login", "JSONbored", "--json"]);
    fixtureOptions.decisionPackStatus = 403;

    await expect(captureStdout(() => mod.runCli(["decision-pack", "--login", "JSONbored", "--json"]))).rejects.toThrow(/LoopOver API 403/);
  });

  it("does not use stale decision-pack cache for non-JSON authorization failures", async () => {
    await runCliJson(["decision-pack", "--login", "JSONbored", "--json"]);
    fixtureOptions.decisionPackStatus = 403;
    fixtureOptions.decisionPackErrorBody = "<html>forbidden</html>";
    fixtureOptions.decisionPackErrorContentType = "text/html";
    fixtureOptions.repoDecisionStatus = 403;
    fixtureOptions.repoDecisionErrorBody = "<html>forbidden</html>";
    fixtureOptions.repoDecisionErrorContentType = "text/html";

    await expect(captureStdout(() => mod.runCli(["decision-pack", "--login", "JSONbored", "--json"]))).rejects.toThrow(/LoopOver API 403/);
    await expect(captureStdout(() => mod.runCli(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/loopover", "--json"]))).rejects.toThrow(
      /LoopOver API 403/,
    );
  });

  it("does not use stale decision-pack cache when local credentials are missing", async () => {
    await runCliJson(["decision-pack", "--login", "JSONbored", "--json"]);
    process.env.LOOPOVER_API_TOKEN = "";
    process.env.LOOPOVER_TOKEN = "";
    process.env.LOOPOVER_MCP_TOKEN = "";

    await expect(captureStdout(() => mod.runCli(["decision-pack", "--login", "JSONbored", "--json"]))).rejects.toThrow(/Run `loopover-mcp login`/);
    await expect(captureStdout(() => mod.runCli(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/loopover", "--json"]))).rejects.toThrow(
      /Run `loopover-mcp login`/,
    );
  });

  it("runs base-agent CLI commands against API fixtures", async () => {
    const plan = (await runCliJson(["agent", "plan", "--login", "JSONbored", "--repo", "JSONbored/loopover", "--json"])) as {
      run: { id: string; status: string };
      actions: Array<{ actionType: string }>;
    };
    expect(plan.run).toMatchObject({ id: "run-1", status: "completed" });
    expect(plan.actions[0]).toMatchObject({ actionType: "choose_next_work" });

    const planText = await captureStdout(() => mod.runCli(["agent", "plan", "--login", "JSONbored", "--repo", "JSONbored/loopover"]));
    expect(planText).toContain("why now:");
    expect(planText).toContain("impact:");
    expect(planText).toContain("rerun:");
    expect(planText).not.toMatch(/wallet|hotkey|raw trust|payout|farming|private reviewability|public score estimate/i);

    const statusPayload = (await runCliJson(["agent", "status", "run-1", "--json"])) as { run: { id: string } };
    expect(statusPayload.run.id).toBe("run-1");

    const explain = (await runCliJson(["agent", "explain", "run-1", "--json"])) as { topAction: { actionType: string } };
    expect(explain.topAction.actionType).toBe("choose_next_work");
  });

  it("prints copy-paste public-safe markdown for agent packet output", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    tempDir = repoDir;
    git(repoDir, "init");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "LoopOver Test");
    git(repoDir, "config", "commit.gpgsign", "false");
    git(repoDir, "remote", "add", "origin", "git@github.com:JSONbored/loopover.git");
    writeFileSync(join(repoDir, "README.md"), "fixture\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "initial commit");
    git(repoDir, "checkout", "-b", "codex/public-safe-pr-packets");
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src/packet.ts"), "export const packet = true;\n");
    const output = await captureStdout(() =>
      mod.runCli([
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        repoDir,
        "--base",
        "HEAD",
        "--body",
        "Closes #39",
        "--validation",
        "passed|npm test|packet tests passed",
      ]),
    );

    expect(output).toContain("# Public-safe PR packet");
    expect(output).toContain("## Validation");
    expect(output).toContain("Closes #39");
    expect(output).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|raw[-_\s]?trust|private[-_\s]?reviewability|reviewability|export const packet/i);
  });

  it("rejects unsafe server-provided packet markdown before non-json output", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    tempDir = repoDir;
    git(repoDir, "init");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "LoopOver Test");
    git(repoDir, "config", "commit.gpgsign", "false");
    git(repoDir, "remote", "add", "origin", "git@github.com:JSONbored/loopover.git");
    writeFileSync(join(repoDir, "README.md"), "fixture\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "initial commit");
    git(repoDir, "checkout", "-b", "codex/public-safe-pr-packets");

    for (const unsafePhrase of [
      "score: 1.15",
      "reward estimate",
      "wallet address",
      "hotkey id",
      "raw-trust: 0.7",
      "private-reviewability: ready",
      "raw_trust: 0.7",
      "private_reviewability: ready",
      "trust_score: 0.4",
      "log path C:\\Users\\alice\\workspace\\raw.log",
    ]) {
      fixtureOptions.packetMarkdown = `# Public-safe PR packet\n\n- ${unsafePhrase}\n`;
      await expect(captureStdout(() => mod.runCli(["agent", "packet", "--login", "oktofeesh1", "--cwd", repoDir, "--base", "HEAD"]))).rejects.toThrow(
        "Refusing to print unsafe public packet markdown from the server.",
      );
    }
  }, 45000);

  it("sends bounded structured validation summaries without local logs", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    tempDir = repoDir;
    git(repoDir, "init");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "LoopOver Test");
    git(repoDir, "config", "commit.gpgsign", "false");
    git(repoDir, "remote", "add", "origin", "git@github.com:JSONbored/loopover.git");
    writeFileSync(join(repoDir, "README.md"), "fixture\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "initial commit");
    packetRequests.length = 0;
    await captureStdout(() =>
      mod.runCli([
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        repoDir,
        "--base",
        "HEAD",
        "--validation",
        "focused|npm run test:unit|1234ms|unit passed raw_trust=0.4 /Users/example/log.txt",
        "--validation-command",
        "npm run lint",
        "--validation-status",
        "exit code 1",
        "--validation-duration",
        "2s",
        "--validation-summary",
        "lint failed at C:/Users/alice/raw.log and /tmp/raw.log",
        "--json",
      ]),
    );

    const packet = packetRequests[0] as { validation: Array<{ command: string; status: string; durationMs?: number; exitCode?: number; summary?: string }> };
    expect(packet.validation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "npm run test:unit", status: "focused", durationMs: 1234, exitCode: 0 }),
        expect.objectContaining({ command: "npm run lint", status: "failed", durationMs: 2000, exitCode: 1 }),
      ]),
    );
    expect(JSON.stringify(packet.validation)).not.toMatch(/raw_trust|\/Users\/example|\/tmp\/raw/i);
    expect(JSON.stringify(packet.validation)).not.toMatch(/C:\/Users|alice/i);
  });

  it("sends branch eligibility metadata without local source contents", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src/eligible.ts"), "export const source = 'must stay local';\n");
    git(repoDir, "add", "src/eligible.ts");
    packetRequests.length = 0;
    await captureStdout(() =>
      mod.runCli([
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        repoDir,
        "--base",
        "HEAD",
        "--body",
        "Fixes #90",
        "--branch-eligibility",
        "ineligible",
        "--branch-eligibility-source",
        "github_metadata",
        "--branch-eligibility-reason",
        "head branch is not eligible",
        "--branch-eligibility-stale",
        "false",
        "--json",
      ]),
    );

    const packet = packetRequests[0] as { branchEligibility: { status: string; source: string; reason: string; stale: boolean }; changedFiles: Array<{ path: string }> };
    expect(packet.branchEligibility).toMatchObject({ status: "ineligible", source: "github_metadata", reason: "head branch is not eligible", stale: false });
    expect(packet.changedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/eligible.ts" })]));
    expect(JSON.stringify(packet)).not.toMatch(/must stay local|export const source/);
  });

  it("classifies nonzero validation status phrases as failed", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    tempDir = repoDir;
    git(repoDir, "init");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "LoopOver Test");
    git(repoDir, "config", "commit.gpgsign", "false");
    git(repoDir, "remote", "add", "origin", "git@github.com:JSONbored/loopover.git");
    writeFileSync(join(repoDir, "README.md"), "fixture\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "initial commit");
    packetRequests.length = 0;
    await captureStdout(() =>
      mod.runCli([
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        repoDir,
        "--base",
        "HEAD",
        "--validation-command",
        "npm test",
        "--validation-status",
        "status: 2",
        "--json",
      ]),
    );

    const packet = packetRequests[0] as { validation: Array<{ command: string; status: string; exitCode?: number }> };
    expect(packet.validation).toEqual(expect.arrayContaining([expect.objectContaining({ command: "npm test", status: "failed", exitCode: 2 })]));
  });

  it("classifies bare nonzero validation statuses as failed", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    const validation = await captureInProcessPacketValidation(repoDir, [
      "--validation",
      "npm test|1",
      "--validation-command",
      "npm run lint",
      "--validation-status",
      "2",
    ]);

    expect(validation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "npm test", status: "failed", exitCode: 1 }),
        expect.objectContaining({ command: "npm run lint", status: "failed", exitCode: 2 }),
      ]),
    );
  });

  it("does not infer HTTP status summaries as process exit codes", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    const validation = await captureInProcessPacketValidation(repoDir, ["--validation", "npm run e2e|HTTP status 200 OK"]);

    expect(validation).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "npm run e2e", status: "not_run", summary: "HTTP status 200 OK" })]),
    );
    expect(validation[0]).not.toHaveProperty("exitCode");
  });

  it("infers expanded validation failures from summaries when status is absent", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    const validation = await captureInProcessPacketValidation(repoDir, ["--validation-command", "npm test", "--validation-summary", "exit code 1"]);

    expect(validation).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "npm test", status: "failed", exitCode: 1, summary: "exit code 1" })]),
    );
  });

  it("redacts space-containing local paths and private metric values from validation text", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    const validation = await captureInProcessPacketValidation(repoDir, [
      "--validation-command",
      "node /Users/Alice Smith/project/run.js",
      "--validation-status",
      "failed",
      "--validation-summary",
      "log=C:\\Users\\Alice Smith\\raw.log raw_trust=0.72 private_reviewability=ready",
    ]);

    expect(validation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "node <local-path>",
          status: "failed",
          summary: "log=<local-path> [redacted] [redacted]",
        }),
      ]),
    );
    expect(JSON.stringify(validation)).not.toMatch(/Alice Smith|Smith[\\/]|raw\.log|0\.72|ready|\[redacted\]=/);
  });
});
