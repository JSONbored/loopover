import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { listAuditEventsForTarget, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// #9298: MCP mirror of POST /v1/repos/:owner/:repo/pulls/:number/incident-reports (#5672). The write itself
// persists through the same recordPostMergeIncidentReport helper into a PR-keyed `audit_events` row, read
// back here through listAuditEventsForTarget -- the exact `repo#number` target the REST route documents (the
// agent-audit-feed tool is deliberately scoped to `agent.action.%`/`agent.pending_action.%`, not this event).

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

beforeEach(() => {
  mockedPermission.mockReset();
  mockedPermission.mockResolvedValue("write");
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-file-incident-report-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedRepoWithPulls(env: Env) {
  await upsertInstallation(env, {
    installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
  await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "Merged PR", state: "closed", merged_at: "2026-06-18T10:00:00.000Z", user: { login: "a-miner" }, head: { sha: "deadbeef" }, labels: [], body: "x" });
  await upsertPullRequestFromGitHub(env, "owner/repo", { number: 8, title: "Open PR", state: "open", user: { login: "a-miner" }, head: { sha: "open-sha" }, labels: [], body: "x" });
}

async function metadataRow(env: Env): Promise<{ target_key: string; actor: string; detail: string; metadata_json: string } | null> {
  return env.DB.prepare(
    "select target_key, actor, detail, metadata_json from audit_events where event_type = 'agent.post_merge_incident_reported' order by created_at desc limit 1",
  ).first<{ target_key: string; actor: string; detail: string; metadata_json: string }>();
}

describe("MCP loopover_file_incident_report (#9298)", () => {
  it("files a report on a merged PR for the shared mcp token, and it reads back on the PR's audit target", async () => {
    const env = createTestEnv();
    await seedRepoWithPulls(env);
    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }

    const result = await client.callTool({ name: "loopover_file_incident_report", arguments: { owner: "owner", repo: "repo", number: 7, description: "broke prod config", severity: "high", mergedSha: "deadbeef" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { ok: boolean; repoFullName: string; pullNumber: number; id: string; createdAt: string };
    expect(data).toMatchObject({ ok: true, repoFullName: "owner/repo", pullNumber: 7 });
    expect(typeof data.id).toBe("string");
    expect(typeof data.createdAt).toBe("string");
    expect(JSON.stringify(result.content)).toContain("Filed a post-merge incident report on owner/repo#7");

    // Regression: the recorded incident is one `audit_events` row keyed to the PR (`repo#number`), readable
    // back through the same listAuditEventsForTarget path recordPostMergeIncidentReport documents.
    const events = await listAuditEventsForTarget(env, { repoFullName: "owner/repo", pullNumber: 7 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "agent.post_merge_incident_reported", outcome: "completed", actor: "mcp", detail: "broke prod config" });
    const row = await metadataRow(env);
    expect(row?.target_key).toBe("owner/repo#7");
    expect(JSON.parse(row!.metadata_json)).toMatchObject({ severity: "high", mergedSha: "deadbeef", reporterKind: "customer" });
  });

  it("records the reporting maintainer's own login as actor for a session caller, and omits mergedSha as null", async () => {
    const env = createTestEnv();
    await seedRepoWithPulls(env);
    const client = await connect(env, { kind: "session", actor: "owner" } as AuthIdentity);

    const result = await client.callTool({ name: "loopover_file_incident_report", arguments: { owner: "owner", repo: "repo", number: 7, description: "silent data loss", severity: "critical" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, repoFullName: "owner/repo", pullNumber: 7 });

    const events = await listAuditEventsForTarget(env, { repoFullName: "owner/repo", pullNumber: 7 });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("owner");
    const row = await metadataRow(env);
    expect(JSON.parse(row!.metadata_json)).toMatchObject({ severity: "critical", mergedSha: null, reporterKind: "customer" });
  });

  it("returns pull_request_not_found for an unknown PR without recording anything", async () => {
    const env = createTestEnv();
    await seedRepoWithPulls(env);
    const client = await connect(env);

    const result = await client.callTool({ name: "loopover_file_incident_report", arguments: { owner: "owner", repo: "repo", number: 999, description: "x", severity: "low" } });
    expect(result.isError).toBeFalsy(); // a business rejection is a normal tool result, not an MCP-level error
    expect(result.structuredContent).toMatchObject({ ok: false, error: "pull_request_not_found", repoFullName: "owner/repo", pullNumber: 999 });
    expect(await metadataRow(env)).toBeFalsy();
  });

  it("returns pull_request_not_merged for an open PR without recording anything", async () => {
    const env = createTestEnv();
    await seedRepoWithPulls(env);
    const client = await connect(env);

    const result = await client.callTool({ name: "loopover_file_incident_report", arguments: { owner: "owner", repo: "repo", number: 8, description: "x", severity: "low" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: false, error: "pull_request_not_merged", repoFullName: "owner/repo", pullNumber: 8 });
    expect(await metadataRow(env)).toBeFalsy();
  });

  it("rejects a caller lacking maintainer-manage access, recording nothing", async () => {
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await seedRepoWithPulls(env);
    const client = await connect(env); // default static mcp identity, no actuation allowlist

    const result = await client.callTool({ name: "loopover_file_incident_report", arguments: { owner: "owner", repo: "repo", number: 7, description: "x", severity: "low" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
    expect(await metadataRow(env)).toBeFalsy();
  });
});
