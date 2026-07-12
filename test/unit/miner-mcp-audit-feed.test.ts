import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMinerMcpServer } from "../../packages/gittensory-miner/bin/gittensory-miner-mcp.js";
import {
  AUDIT_FEED_ENTRY_FIELDS,
  collectEventLedgerAuditFeed,
  normalizeAuditFeedMcpFilter,
  projectLedgerEventToAuditFeedEntry,
} from "../../packages/gittensory-miner/lib/event-ledger-cli.js";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";

type Content = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-mcp-audit-feed-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultEventLedger();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connectedClient(eventLedger: ReturnType<typeof initEventLedger>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-audit-feed-test", version: "0.0.0" });
  await Promise.all([
    createMinerMcpServer({ initEventLedger: () => eventLedger }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function toolText(result: Content): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

function seedEvents(eventLedger: ReturnType<typeof initEventLedger>) {
  eventLedger.appendEvent({
    type: "discovered_issue",
    repoFullName: "acme/widgets",
    payload: { issueNumber: 1, secretBlob: "must-not-leak" },
  });
  eventLedger.appendEvent({
    type: "manage_pr_update",
    repoFullName: "acme/widgets",
    payload: {
      prNumber: 7,
      outcome: "ready",
      actor: "miner-bot",
      detail: "gate passed",
    },
  });
  eventLedger.appendEvent({
    type: "manage_pr_update",
    repoFullName: "acme/other",
    payload: { prNumber: 3, outcome: "needs-work" },
  });
}

describe("gittensory_miner_get_audit_feed (#5158)", () => {
  it("is registered on the miner MCP server", async () => {
    const ledger = tempLedger();
    const client = await connectedClient(ledger);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("gittensory_miner_get_audit_feed");
  });

  it("returns metadata-only audit rows with repo, since, and type filters", async () => {
    const ledger = tempLedger();
    seedEvents(ledger);
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_audit_feed",
      arguments: { repoFullName: "acme/widgets", since: 1, type: "manage_pr_update" },
    })) as Content;
    const payload = JSON.parse(toolText(result));
    expect(payload.repoFullName).toBe("acme/widgets");
    expect(payload.events).toEqual([
      {
        eventType: "manage_pr_update",
        repoFullName: "acme/widgets",
        outcome: "ready",
        actor: "miner-bot",
        detail: "gate passed",
        createdAt: expect.any(String),
      },
    ]);
  });

  it("returns an empty events array for an empty ledger", async () => {
    const ledger = tempLedger();
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_audit_feed",
      arguments: {},
    })) as Content;
    expect(JSON.parse(toolText(result))).toEqual({ events: [] });
  });

  it("is structurally identical to collectEventLedgerAuditFeed() — the wrapper adds no drift (invariant)", async () => {
    const ledger = tempLedger();
    seedEvents(ledger);
    const filter = normalizeAuditFeedMcpFilter({ repoFullName: "acme/widgets" });
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_audit_feed",
      arguments: { repoFullName: "acme/widgets" },
    })) as Content;
    expect(JSON.parse(toolText(result))).toEqual(collectEventLedgerAuditFeed(ledger, filter));
  });

  it("never exposes fields beyond the metadata-only audit-feed columns (invariant)", async () => {
    const ledger = tempLedger();
    seedEvents(ledger);
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_audit_feed",
      arguments: {},
    })) as Content;
    const payload = JSON.parse(toolText(result));
    for (const event of payload.events) {
      expect(Object.keys(event).sort()).toEqual([...AUDIT_FEED_ENTRY_FIELDS].sort());
      expect(JSON.stringify(event)).not.toContain("must-not-leak");
      expect(JSON.stringify(event)).not.toContain("payload");
      expect(JSON.stringify(event)).not.toContain("secretBlob");
    }
  });

  it("never calls mutating event-ledger methods — only readEvents (invariant)", async () => {
    const ledger = tempLedger();
    seedEvents(ledger);
    const appendEvent = vi.spyOn(ledger, "appendEvent");
    const readEvents = vi.spyOn(ledger, "readEvents");
    const client = await connectedClient(ledger);
    await client.callTool({
      name: "gittensory_miner_get_audit_feed",
      arguments: { type: "manage_pr_update" },
    });
    expect(readEvents).toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("returns an MCP error for invalid since cursors", async () => {
    const ledger = tempLedger();
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_audit_feed",
      arguments: { since: -1 },
    })) as Content;
    expect(result.isError).toBe(true);
    expect(toolText(result)).toMatch(/Invalid arguments|since|invalid/i);
  });
});

describe("event-ledger audit-feed projection (#5158)", () => {
  it("projectLedgerEventToAuditFeedEntry strips payload columns and keeps declared metadata strings", () => {
    const projected = projectLedgerEventToAuditFeedEntry({
      id: 1,
      seq: 2,
      type: "manage_pr_update",
      repoFullName: "acme/widgets",
      payload: {
        prNumber: 7,
        outcome: "ready",
        actor: "miner-bot",
        detail: "gate passed",
        secretBlob: "must-not-leak",
      },
      createdAt: "2026-07-04T12:00:00.000Z",
    });
    expect(projected).toEqual({
      eventType: "manage_pr_update",
      repoFullName: "acme/widgets",
      outcome: "ready",
      actor: "miner-bot",
      detail: "gate passed",
      createdAt: "2026-07-04T12:00:00.000Z",
    });
  });

  it("normalizeAuditFeedMcpFilter mirrors ledger list filter semantics", () => {
    expect(
      normalizeAuditFeedMcpFilter({
        repoFullName: "acme/widgets",
        since: 3,
        type: "manage_pr_update",
      }),
    ).toEqual({
      repoFullName: "acme/widgets",
      since: 3,
      type: "manage_pr_update",
    });
    expect(() => normalizeAuditFeedMcpFilter({ repoFullName: "bad" })).toThrow(
      "Repository must be in owner/repo form.",
    );
    expect(() => normalizeAuditFeedMcpFilter(null as unknown as Parameters<typeof normalizeAuditFeedMcpFilter>[0])).toThrow(
      "filter must be an object",
    );
    expect(() => normalizeAuditFeedMcpFilter({ type: "  " })).toThrow("type must be a non-empty string.");
  });

  it("projectLedgerEventToAuditFeedEntry nulls blank metadata strings and ignores non-object payloads", () => {
    expect(
      projectLedgerEventToAuditFeedEntry({
        id: 1,
        seq: 2,
        type: "manage_pr_update",
        repoFullName: "acme/widgets",
        payload: { outcome: "  ", actor: 42, detail: null },
        createdAt: "2026-07-04T12:00:00.000Z",
      }),
    ).toEqual({
      eventType: "manage_pr_update",
      repoFullName: "acme/widgets",
      outcome: null,
      actor: null,
      detail: null,
      createdAt: "2026-07-04T12:00:00.000Z",
    });
    expect(
      projectLedgerEventToAuditFeedEntry({
        id: 3,
        seq: 4,
        type: "discovered_issue",
        repoFullName: "acme/widgets",
        payload: ["not-an-object"] as unknown as Record<string, unknown>,
        createdAt: "2026-07-04T12:00:00.000Z",
      }),
    ).toEqual({
      eventType: "discovered_issue",
      repoFullName: "acme/widgets",
      outcome: null,
      actor: null,
      detail: null,
      createdAt: "2026-07-04T12:00:00.000Z",
    });
  });
});
