import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMinerMcpServer } from "../../packages/gittensory-miner/bin/loopover-miner-mcp.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";

// gittensory_miner_get_governor_decisions (#5159). Driven against a REAL temp governor ledger (not a fake) so the
// redaction assertion exercises the actual explicit-named-column SQL — it must fail if a future edit widens the
// SELECT to include payload_json.

type Content = { content: Array<{ type: string; text?: string }> };
type GovernorLedgerHandle = ReturnType<typeof initGovernorLedger>;

const roots: string[] = [];
function tempGovernorLedger(): GovernorLedgerHandle {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-mcp-governor-"));
  roots.push(root);
  return initGovernorLedger(join(root, "governor-ledger.sqlite3"));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function toolText(result: Content): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

async function callGovernorDecisions(
  ledger: GovernorLedgerHandle,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-governor-test", version: "0.0.0" });
  await Promise.all([
    createMinerMcpServer({ initGovernorLedger: () => ledger }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = (await client.callTool({
    name: "gittensory_miner_get_governor_decisions",
    arguments: args,
  })) as Content;
  return JSON.parse(toolText(result));
}

describe("gittensory_miner_get_governor_decisions (#5159)", () => {
  it("projects the decision columns and NEVER leaks payload / reputation / budget (redaction by construction)", async () => {
    const ledger = tempGovernorLedger();
    ledger.appendGovernorEvent({
      eventType: "denied",
      repoFullName: "acme/api",
      actionClass: "write",
      decision: "block",
      reason: "house rule violation",
      // Sensitive state that #5134 is expanding into payload_json — must never surface through this read tool.
      payload: { reputation: 0.2, self_plagiarism: true, budget: { remaining: 0 }, note: "secretish" },
    });

    const decisions = (await callGovernorDecisions(ledger)) as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual({
      id: expect.any(Number),
      ts: expect.any(String),
      eventType: "denied",
      repoFullName: "acme/api",
      actionClass: "write",
      decision: "block",
      reason: "house rule violation",
    });
    for (const forbidden of ["payload", "payload_json", "reputation", "self_plagiarism", "selfPlagiarism", "budget"]) {
      expect(decisions[0]).not.toHaveProperty(forbidden);
    }
    // Belt-and-suspenders: the sensitive payload keys/values never appear anywhere in the serialized response.
    // (Only tokens that cannot legitimately occur in a projected column — "budget" is skipped because it may
    // appear in a decision `reason`; the not.toHaveProperty checks above already guard the payload key itself.)
    const serialized = JSON.stringify(decisions);
    for (const forbidden of ["reputation", "self_plagiarism", "secretish"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("filters by repoFullName", async () => {
    const ledger = tempGovernorLedger();
    for (const repo of ["acme/api", "acme/web"]) {
      ledger.appendGovernorEvent({
        eventType: "allowed",
        repoFullName: repo,
        actionClass: "analyze",
        decision: "allow",
        reason: "within budget",
      });
    }
    const decisions = (await callGovernorDecisions(ledger, { repoFullName: "acme/web" })) as Array<{
      repoFullName: string;
    }>;
    expect(decisions.map((decision) => decision.repoFullName)).toEqual(["acme/web"]);
  });

  it("returns an empty array when nothing matches", async () => {
    const ledger = tempGovernorLedger();
    expect(await callGovernorDecisions(ledger, { repoFullName: "none/here" })).toEqual([]);
  });
});
