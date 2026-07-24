import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildPublicPrBodyDraft } from "../../packages/loopover-engine/src/pr-body-draft";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeFixtureServer,
  createPacketRepo,
  run,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #6741: CLI stdio mirror of loopover_draft_pr_body — analyzeCurrentBranch then local buildPublicPrBodyDraft.
const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS =
  /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: unknown })
    .structuredContent as Record<string, unknown>;
}

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let repoDir: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-draft-pr-body-"));
  repoDir = createPacketRepo();
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (
        request.url?.includes("/v1/local/branch-analysis") &&
        request.method === "POST"
      ) {
        capturedRequests.push({
          url: request.url ?? "",
          method: request.method ?? "POST",
        });
      }
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
  client = new Client({ name: "draft-pr-body-cli-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
}

describe("loopover_draft_pr_body stdio mirror (#6741)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("loopover_draft_pr_body");
  });

  it("fetches branch analysis then returns a draft matching buildPublicPrBodyDraft", async () => {
    const result = await client.callTool({
      name: "loopover_draft_pr_body",
      arguments: {
        login: "JSONbored",
        cwd: repoDir,
        repoFullName: "JSONbored/loopover",
        baseRef: "HEAD",
      },
    });
    expect(capturedRequests.length).toBe(1);
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    const data = structured(result);
    expect(data.sourceUploadDisabled).toBe(true);
    expect(data.markdown).toEqual(
      expect.stringContaining("# Local branch preflight"),
    );
    expect(data.title).toBe("Local branch preflight");
    // Parity: same engine export over the fixture analysis shape yields the same markdown.
    const expected = buildPublicPrBodyDraft({
      repoFullName: "JSONbored/loopover",
      prPacket: {
        titleSuggestion: "Local branch preflight",
        bodySections: [
          {
            heading: "Changed Paths",
            lines: ["- src/widget.ts (modified, +8/-1)"],
          },
        ],
        validationSummary: {
          passed: 1,
          failed: 0,
          notRun: 0,
          commands: [{ command: "npm test", status: "passed", summary: "ok" }],
        },
        publicSafeWarnings: [],
      },
      baseFreshness: {
        status: "fresh",
        changedFileCount: 1,
        testFileCount: 0,
        warnings: [],
      },
      manifestGuidance: { present: false, publicNextSteps: [] },
      preflight: { linkedIssues: [42], collisions: [] },
    });
    expect(data.markdown).toBe(expected.markdown);
  });

  it("honors format=markdown", async () => {
    const result = await client.callTool({
      name: "loopover_draft_pr_body",
      arguments: {
        login: "JSONbored",
        cwd: repoDir,
        repoFullName: "JSONbored/loopover",
        baseRef: "HEAD",
        format: "markdown",
      },
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(data).toMatchObject({
      title: "Local branch preflight",
      repoFullName: "JSONbored/loopover",
      sourceUploadDisabled: true,
    });
    expect(typeof data.markdown).toBe("string");
    expect(data.sections).toBeUndefined();
  });

  it("lists the tool via loopover-mcp tools", () => {
    const payload = JSON.parse(run(["tools", "--json"])) as {
      tools: Array<{ name: string; description: string }>;
    };
    const tool = payload.tools.find(
      (entry) => entry.name === "loopover_draft_pr_body",
    );
    expect(tool?.description).toMatch(/PR body/i);
    expect(tool?.description.trim().length).toBeGreaterThan(0);
  });
});
