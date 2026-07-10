import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string; body: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-issue-rag-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/v1/issue-rag/retrieve")) {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          capturedRequests.push({
            url: request.url ?? "",
            method: request.method ?? "GET",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_URL: apiUrl,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "issue-rag-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("gittensory_retrieve_issue_context stdio proxy", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server's tool list", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("gittensory_retrieve_issue_context");
  });

  it("proxies the call to /v1/issue-rag/retrieve via apiPost", async () => {
    await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: {
        owner: "JSONbored",
        repo: "gittensory",
        title: "Improve SQLite backup readiness checks",
        labels: ["selfhost"],
        topK: 6,
      },
    });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/issue-rag/retrieve");
    expect(captured.method).toBe("POST");
    const parsedBody = JSON.parse(captured.body) as {
      owner?: string;
      repo?: string;
      title?: string;
      labels?: string[];
      topK?: number;
      body?: string;
    };
    expect(parsedBody.owner).toBe("JSONbored");
    expect(parsedBody.repo).toBe("gittensory");
    expect(parsedBody.title).toBe("Improve SQLite backup readiness checks");
    expect(parsedBody.labels).toEqual(["selfhost"]);
    expect(parsedBody.topK).toBe(6);
    expect("body" in parsedBody).toBe(false);
  });

  it("returns metadata-only retrieval telemetry", async () => {
    const result = await client.callTool({
      name: "gittensory_retrieve_issue_context",
      arguments: {
        owner: "JSONbored",
        repo: "gittensory",
        title: "Improve SQLite backup readiness checks",
      },
    });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("retrievedPaths");
    expect(text).not.toMatch(/RELEVANT EXISTING CODE|export function/i);
  });
});
