import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capturePacketValidation,
  closeFixtureServer,
  createPacketRepo,
  decisionPackCacheFile,
  git,
  readDecisionPackCacheText,
  run,
  runAsync,
  startFixtureServer,
} from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — packets", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("caches last-good decision packs and returns explicitly stale local fallback when the API is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    };

    const online = JSON.parse(await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)) as { status: string; source: string };
    expect(online).toMatchObject({ status: "ready", source: "snapshot" });

    const cacheText = readDecisionPackCacheText(tempDir);
    expect(cacheText).toMatch(/"authCacheKey":/);
    expect(cacheText).not.toContain("session-token");
    expect(cacheText).not.toMatch(/must stay local|wallet-value|hotkey-value|\/tmp\/source/i);

    await closeFixtureServer();

    const offline = JSON.parse(await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)) as {
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
      cache: { source: "local_cache", clearCommand: "gittensory-mcp cache clear" },
    });
    expect(offline.cachedAt).toEqual(expect.any(String));
    expect(offline.cache.rerunGuidance).toMatch(/Retry when Gittensory API access is restored/);

    const repoDecision = JSON.parse(await runAsync(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/gittensory", "--json"], env)) as {
      status: string;
      source: string;
      stale: boolean;
      decision: { repoFullName: string; recommendation: string };
    };
    expect(repoDecision).toMatchObject({
      status: "ready",
      source: "local_cache",
      stale: true,
      decision: { repoFullName: "JSONbored/gittensory", recommendation: "pursue" },
    });
  });

  it("ignores incompatible decision-pack cache entries and clears cache entries on request", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    const cachePath = decisionPackCacheFile(tempDir);
    const entry = JSON.parse(readFileSync(cachePath, "utf8"));
    writeFileSync(cachePath, `${JSON.stringify({ ...entry, schemaVersion: 999 }, null, 2)}\n`, { mode: 0o600 });

    await closeFixtureServer();

    await expect(runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)).rejects.toThrow(/fetch failed|ECONNREFUSED|AbortError|aborted/i);

    const cleared = JSON.parse(run(["cache", "clear", "--json"], env)) as { status: string; removed: number };
    expect(cleared).toMatchObject({ status: "cleared", removed: 1 });
    const cacheStatus = JSON.parse(run(["cache", "status", "--json"], env)) as { entries: number };
    expect(cacheStatus.entries).toBe(0);
  });

  it("lists cached decision packs with safe metadata only", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    };

    const empty = JSON.parse(run(["cache", "list", "--json"], env)) as { count: number; entries: unknown[] };
    expect(empty).toMatchObject({ count: 0, entries: [] });

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    const listed = JSON.parse(run(["cache", "list", "--json"], env)) as {
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

    const human = run(["cache", "list"], env);
    expect(human).toContain("jsonbored");
  });

  it("cache list --format ndjson streams one JSON object per cached entry", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    };

    // Empty cache → zero ndjson lines (not a wrapper object).
    expect(run(["cache", "list", "--format", "ndjson"], env).trim()).toBe("");

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    const lines = run(["cache", "list", "--format", "ndjson"], env).trim().split("\n");
    expect(lines).toHaveLength(1);
    const [firstLine] = lines as [string];
    const entry = JSON.parse(firstLine) as { login: string; bytes: number };
    expect(entry).toMatchObject({ login: "jsonbored" });
    expect(entry.bytes).toBeGreaterThan(0);
    // Each line is a bare entry, not the {count, entries} wrapper.
    expect(firstLine).not.toContain('"count"');
  });

  it("does not use stale decision-pack cache created by a different local token", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const fixtureOptions: { decisionPackStatus?: number } = {};
    const url = await startFixtureServer(fixtureOptions);
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    fixtureOptions.decisionPackStatus = 429;

    await expect(
      runAsync(["decision-pack", "--login", "JSONbored", "--json"], {
        ...env,
        GITTENSORY_TOKEN: "different-session-token",
      }),
    ).rejects.toThrow(/Gittensory API 429/);
  });

  it("does not use stale decision-pack cache for authorization failures", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const fixtureOptions: { decisionPackStatus?: number } = {};
    const url = await startFixtureServer(fixtureOptions);
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    fixtureOptions.decisionPackStatus = 403;

    await expect(runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)).rejects.toThrow(/Gittensory API 403/);
  });

  it("does not use stale decision-pack cache for non-JSON authorization failures", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const fixtureOptions: {
      decisionPackStatus?: number;
      decisionPackErrorBody?: string;
      decisionPackErrorContentType?: string;
      repoDecisionStatus?: number;
      repoDecisionErrorBody?: string;
      repoDecisionErrorContentType?: string;
    } = {};
    const url = await startFixtureServer(fixtureOptions);
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    fixtureOptions.decisionPackStatus = 403;
    fixtureOptions.decisionPackErrorBody = "<html>forbidden</html>";
    fixtureOptions.decisionPackErrorContentType = "text/html";
    fixtureOptions.repoDecisionStatus = 403;
    fixtureOptions.repoDecisionErrorBody = "<html>forbidden</html>";
    fixtureOptions.repoDecisionErrorContentType = "text/html";

    await expect(runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)).rejects.toThrow(/Gittensory API 403/);
    await expect(runAsync(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/gittensory", "--json"], env)).rejects.toThrow(/Gittensory API 403/);
  });

  it("does not use stale decision-pack cache when local credentials are missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    const withoutToken = {
      ...env,
      LOOPOVER_API_TOKEN: "",
      GITTENSORY_TOKEN: "",
      LOOPOVER_MCP_TOKEN: "",
    };

    await expect(runAsync(["decision-pack", "--login", "JSONbored", "--json"], withoutToken)).rejects.toThrow(/Run `gittensory-mcp login`/);
    await expect(runAsync(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/gittensory", "--json"], withoutToken)).rejects.toThrow(
      /Run `gittensory-mcp login`/,
    );
  });

  it("runs base-agent CLI commands against API fixtures", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    const plan = JSON.parse(await runAsync(["agent", "plan", "--login", "JSONbored", "--repo", "JSONbored/gittensory", "--json"], env)) as {
      run: { id: string; status: string };
      actions: Array<{ actionType: string }>;
    };
    expect(plan.run).toMatchObject({ id: "run-1", status: "completed" });
    expect(plan.actions[0]).toMatchObject({ actionType: "choose_next_work" });

    const planText = await runAsync(["agent", "plan", "--login", "JSONbored", "--repo", "JSONbored/gittensory"], env);
    expect(planText).toContain("why now:");
    expect(planText).toContain("impact:");
    expect(planText).toContain("rerun:");
    expect(planText).not.toMatch(/wallet|hotkey|raw trust|payout|farming|private reviewability|public score estimate/i);

    const statusPayload = JSON.parse(await runAsync(["agent", "status", "run-1", "--json"], env)) as { run: { id: string } };
    expect(statusPayload.run.id).toBe("run-1");

    const explain = JSON.parse(await runAsync(["agent", "explain", "run-1", "--json"], env)) as { topAction: { actionType: string } };
    expect(explain.topAction.actionType).toBe("choose_next_work");
  });

  it("prints copy-paste public-safe markdown for agent packet output", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    git(tempDir, "checkout", "-b", "codex/public-safe-pr-packets");
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src/packet.ts"), "export const packet = true;\n");
    const url = await startFixtureServer();
    const output = await runAsync(
      ["agent", "packet", "--login", "oktofeesh1", "--cwd", tempDir, "--base", "HEAD", "--body", "Closes #39", "--validation", "passed|npm test|packet tests passed"],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    expect(output).toContain("# Public-safe PR packet");
    expect(output).toContain("## Validation");
    expect(output).toContain("Closes #39");
    expect(output).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|raw[-_\s]?trust|private[-_\s]?reviewability|reviewability|export const packet/i);
  });

  it("rejects unsafe server-provided packet markdown before non-json output", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    git(tempDir, "checkout", "-b", "codex/public-safe-pr-packets");

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
      await closeFixtureServer();
      const url = await startFixtureServer({ packetMarkdown: `# Public-safe PR packet\n\n- ${unsafePhrase}\n` });
      await expect(
        runAsync(
          ["agent", "packet", "--login", "oktofeesh1", "--cwd", tempDir, "--base", "HEAD"],
          {
            GITTENSORY_API_URL: url,
            GITTENSORY_TOKEN: "session-token",
            GITTENSORY_CONFIG_DIR: tempDir,
            GITTENSORY_API_TIMEOUT_MS: "3000",
          },
        ),
      ).rejects.toThrow("Refusing to print unsafe public packet markdown from the server.");
    }
  }, 45000);

  it("sends bounded structured validation summaries without local logs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    const requests: unknown[] = [];
    const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
    await runAsync(
      [
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        tempDir,
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
      ],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    const packet = requests[0] as { validation: Array<{ command: string; status: string; durationMs?: number; exitCode?: number; summary?: string }> };
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
    tempDir = createPacketRepo();
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src/eligible.ts"), "export const source = 'must stay local';\n");
    git(tempDir, "add", "src/eligible.ts");
    const requests: unknown[] = [];
    const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
    await runAsync(
      [
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        tempDir,
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
      ],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    const packet = requests[0] as { branchEligibility: { status: string; source: string; reason: string; stale: boolean }; changedFiles: Array<{ path: string }> };
    expect(packet.branchEligibility).toMatchObject({ status: "ineligible", source: "github_metadata", reason: "head branch is not eligible", stale: false });
    expect(packet.changedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/eligible.ts" })]));
    expect(JSON.stringify(packet)).not.toMatch(/must stay local|export const source/);
  });

  it("classifies nonzero validation status phrases as failed", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    const requests: unknown[] = [];
    const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
    await runAsync(
      [
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        tempDir,
        "--base",
        "HEAD",
        "--validation-command",
        "npm test",
        "--validation-status",
        "status: 2",
        "--json",
      ],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    const packet = requests[0] as { validation: Array<{ command: string; status: string; exitCode?: number }> };
    expect(packet.validation).toEqual(expect.arrayContaining([expect.objectContaining({ command: "npm test", status: "failed", exitCode: 2 })]));
  });

  it("classifies bare nonzero validation statuses as failed", async () => {
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, [
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
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, ["--validation", "npm run e2e|HTTP status 200 OK"]);

    expect(validation).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "npm run e2e", status: "not_run", summary: "HTTP status 200 OK" })]),
    );
    expect(validation[0]).not.toHaveProperty("exitCode");
  });

  it("infers expanded validation failures from summaries when status is absent", async () => {
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, ["--validation-command", "npm test", "--validation-summary", "exit code 1"]);

    expect(validation).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "npm test", status: "failed", exitCode: 1, summary: "exit code 1" })]),
    );
  });

  it("redacts space-containing local paths and private metric values from validation text", async () => {
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, [
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
