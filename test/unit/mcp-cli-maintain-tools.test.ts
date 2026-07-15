import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #6152 — the five `maintain` CLI subcommands (queue/approve/reject/pause/resume/set-level/precision)
// exposed as stdio MCP tools. Each tool is a thin proxy over the exact REST endpoint its CLI counterpart
// already calls, so these tests assert the proxied URL/method/body as well as the returned payload.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string; body: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-maintain-tools-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request: IncomingMessage) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        capturedRequests.push({
          url: request.url ?? "",
          method: request.method ?? "GET",
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
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
  client = new Client({ name: "maintain-tools-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

function maintainRequests() {
  return capturedRequests.filter((request) => request.url.startsWith("/v1/repos/"));
}

describe("loopover-mcp maintain stdio tools (#6152)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers all five maintainer tools in the stdio tool list", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "loopover_list_pending_actions",
        "loopover_decide_pending_action",
        "loopover_set_agent_paused",
        "loopover_set_action_autonomy",
        "loopover_get_gate_precision",
      ]),
    );
  });

  describe("loopover_list_pending_actions", () => {
    it("lists the approval queue via GET /agent/pending-actions", async () => {
      const result = await client.callTool({ name: "loopover_list_pending_actions", arguments: { owner: "owner", repo: "repo" } });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { repoFullName: string; pendingActions: Array<{ id: string; actionClass: string; pullNumber: number }> };
      expect(data.pendingActions).toEqual([expect.objectContaining({ id: "pa-1", actionClass: "merge", pullNumber: 7 })]);
      expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
      const [captured] = maintainRequests();
      expect(captured).toMatchObject({ url: "/v1/repos/owner/repo/agent/pending-actions", method: "GET" });
    });

    it("surfaces a REST error as a tool error (unknown repo → 404)", async () => {
      const result = await client.callTool({ name: "loopover_list_pending_actions", arguments: { owner: "ghost", repo: "missing" } });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result.content)).toMatch(/404/);
    });
  });

  describe("loopover_decide_pending_action", () => {
    it("accepts a staged action via POST /agent/pending-actions/:id/accept", async () => {
      const result = await client.callTool({ name: "loopover_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: "pa-1", decision: "accept" } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ status: "accepted", executionOutcome: "completed" });
      const [captured] = maintainRequests();
      expect(captured).toMatchObject({ url: "/v1/repos/owner/repo/agent/pending-actions/pa-1/accept", method: "POST" });
    });

    it("rejects a staged action via POST /agent/pending-actions/:id/reject", async () => {
      const result = await client.callTool({ name: "loopover_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: "pa-1", decision: "reject" } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ status: "rejected" });
      expect(maintainRequests()[0]!.url).toBe("/v1/repos/owner/repo/agent/pending-actions/pa-1/reject");
    });

    it("rejects an out-of-enum decision before any request is made", async () => {
      const result = await client.callTool({ name: "loopover_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: "pa-1", decision: "maybe" } });
      expect(result.isError).toBeTruthy();
      expect(maintainRequests()).toHaveLength(0);
    });
  });

  describe("loopover_set_agent_paused", () => {
    it("pauses the repo via PUT /settings with agentPaused:true", async () => {
      const result = await client.callTool({ name: "loopover_set_agent_paused", arguments: { owner: "owner", repo: "repo", paused: true } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ repoFullName: "owner/repo", agentPaused: true });
      const captured = maintainRequests()[0]!;
      expect(captured).toMatchObject({ url: "/v1/repos/owner/repo/settings", method: "PUT" });
      expect(JSON.parse(captured.body)).toEqual({ agentPaused: true });
    });

    it("resumes the repo via PUT /settings with agentPaused:false", async () => {
      const result = await client.callTool({ name: "loopover_set_agent_paused", arguments: { owner: "owner", repo: "repo", paused: false } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ agentPaused: false });
      expect(JSON.parse(maintainRequests()[0]!.body)).toEqual({ agentPaused: false });
    });

    it("surfaces a REST error as a tool error (unknown repo → 404)", async () => {
      const result = await client.callTool({ name: "loopover_set_agent_paused", arguments: { owner: "ghost", repo: "missing", paused: true } });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result.content)).toMatch(/404/);
    });
  });

  describe("loopover_set_action_autonomy", () => {
    it("read-merge-writes one action class, preserving the others", async () => {
      const result = await client.callTool({ name: "loopover_set_action_autonomy", arguments: { owner: "owner", repo: "repo", action: "merge", level: "auto_with_approval" } });
      expect(result.isError).toBeFalsy();
      // The fixture echoes the PUT body's autonomy map back, so the merged shape is observable.
      expect(result.structuredContent).toMatchObject({ autonomy: { label: "auto", merge: "auto_with_approval" } });
      const requests = maintainRequests();
      // Read (GET) then write (PUT) against the same settings endpoint.
      expect(requests[0]).toMatchObject({ url: "/v1/repos/owner/repo/settings", method: "GET" });
      expect(requests[1]).toMatchObject({ url: "/v1/repos/owner/repo/settings", method: "PUT" });
      expect(JSON.parse(requests[1]!.body)).toEqual({ autonomy: { label: "auto", merge: "auto_with_approval" } });
    });

    it("rejects an out-of-enum action/level before writing anything", async () => {
      const result = await client.callTool({ name: "loopover_set_action_autonomy", arguments: { owner: "owner", repo: "repo", action: "bogus", level: "auto" } });
      expect(result.isError).toBeTruthy();
      expect(maintainRequests()).toHaveLength(0);
    });

    it("surfaces a REST error as a tool error (unknown repo → 404 on the read)", async () => {
      const result = await client.callTool({ name: "loopover_set_action_autonomy", arguments: { owner: "ghost", repo: "missing", action: "merge", level: "auto" } });
      expect(result.isError).toBeTruthy();
      // Fails on the read, so the write never happens.
      expect(maintainRequests().every((request) => request.method === "GET")).toBe(true);
    });
  });

  describe("loopover_get_gate_precision", () => {
    it("reads gate precision via GET /gate-precision (full history by default)", async () => {
      const result = await client.callTool({ name: "loopover_get_gate_precision", arguments: { owner: "owner", repo: "repo" } });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { overall: { blocked: number; falsePositiveRate: number }; windowDays: number | null };
      expect(data.overall).toMatchObject({ blocked: 11, falsePositiveRate: 0.182 });
      expect(data.windowDays).toBeNull();
      const [captured] = maintainRequests();
      expect(captured).toMatchObject({ url: "/v1/repos/owner/repo/gate-precision", method: "GET" });
    });

    it("passes windowDays through as the ?windowDays query", async () => {
      const result = await client.callTool({ name: "loopover_get_gate_precision", arguments: { owner: "owner", repo: "repo", windowDays: 30 } });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { windowDays: number | null }).windowDays).toBe(30);
      expect(maintainRequests()[0]!.url).toBe("/v1/repos/owner/repo/gate-precision?windowDays=30");
    });

    it("surfaces a REST error as a tool error (unknown repo → 404)", async () => {
      const result = await client.callTool({ name: "loopover_get_gate_precision", arguments: { owner: "ghost", repo: "missing" } });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result.content)).toMatch(/404/);
    });
  });
});
