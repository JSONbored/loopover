// #6980: CLI + stdio mirrors for loopover_explain_review_risk. The host MCP tool already existed; this pins
// the REST-backed stdio proxy and shell CLI against the same fixture payload.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, reviewRiskFixture, run, runAsync, runExpectingFailure, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedBodies: unknown[];

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-review-risk-"));
  capturedBodies = [];
  apiUrl = await startFixtureServer({
    onReviewRiskRequest: (body) => {
      capturedBodies.push(body);
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "review-risk-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_explain_review_risk stdio proxy (#6980)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_explain_review_risk");
  });

  it("proxies preflight input to POST /v1/preflight/review-risk", async () => {
    const args = { repoFullName: "JSONbored/loopover", title: "Fix cache", contributorLogin: "JSONbored" };
    const result = await client.callTool({ name: "loopover_explain_review_risk", arguments: args });
    expect(capturedBodies).toEqual([args]);
    expect(result.isError).toBeFalsy();
    const toolData = (result as { structuredContent?: unknown }).structuredContent;
    expect(toolData).toEqual(reviewRiskFixture(args));
  });
});

describe("loopover-mcp explain-review-risk CLI (#6980)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("--json emits exactly the payload the MCP tool surfaces for the same input (mirror parity)", async () => {
    const args = { repoFullName: "JSONbored/loopover", title: "Fix cache" };
    const viaTool = await client.callTool({ name: "loopover_explain_review_risk", arguments: args });
    const toolData = (viaTool as { structuredContent?: unknown }).structuredContent;
    const viaCli = JSON.parse(
      await runAsync(["explain-review-risk", "--repo", "JSONbored/loopover", "--title", "Fix cache", "--json"], {
        LOOPOVER_API_URL: apiUrl,
        LOOPOVER_TOKEN: "session-token",
      }),
    );
    expect(viaCli).toEqual(reviewRiskFixture(args));
    if (toolData !== undefined) expect(viaCli).toEqual(toolData);
  });

  it("prints the summary and recommendation on the plain-text path", async () => {
    const out = await runAsync(["explain-review-risk", "--repoFullName", "JSONbored/loopover", "--title", "Fix cache"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(out).toContain("LoopOver review-risk explanation for JSONbored/loopover.");
    expect(out).toContain("Recommendation: review");
    expect(out).toContain("Preflight status: ready");
  });

  it("forwards --login as contributorLogin", async () => {
    await runAsync(["explain-review-risk", "--repo", "JSONbored/loopover", "--title", "Fix cache", "--login", "JSONbored", "--json"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(capturedBodies.at(-1)).toMatchObject({ contributorLogin: "JSONbored", repoFullName: "JSONbored/loopover", title: "Fix cache" });
  });

  it("fails when --repo or --title is missing", () => {
    const noRepo = runExpectingFailure(["explain-review-risk", "--title", "Fix cache"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(noRepo.status).toBe(1);
    expect(`${noRepo.stdout}${noRepo.stderr}`).toMatch(/Pass --repo owner\/repo or --repoFullName/);

    const noTitle = runExpectingFailure(["explain-review-risk", "--repo", "JSONbored/loopover"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(noTitle.status).toBe(1);
    expect(`${noTitle.stdout}${noTitle.stderr}`).toMatch(/Pass --title/);
  });

  it("documents itself in --help and in the shell-completion command list", () => {
    expect(run(["--help"])).toContain("loopover-mcp explain-review-risk --repo owner/repo --title <text>");
    expect(run(["explain-review-risk", "--help"])).toContain("Mirrors the loopover_explain_review_risk MCP tool");
    expect(run(["completion", "bash"])).toContain("explain-review-risk");
  });
});
