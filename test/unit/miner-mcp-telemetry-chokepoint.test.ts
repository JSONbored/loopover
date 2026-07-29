// Every miner tool call reaches the dispatch-telemetry chokepoint (#9658).
//
// `withMinerToolErrorHandling`'s own doc calls the tool name REQUIRED "so this same wrapper doubles as the
// miner's dispatch-telemetry chokepoint... leaving it optional would have made 'instrumented' a property of
// each call site rather than of the wrapper". Twenty registrations honoured that; `loopover_miner_ping` did
// not, and nothing noticed -- so the health check an operator's monitoring hits on a loop, the cheapest
// signal that this server is alive at all, reported zero calls forever.
//
// Two checks, because either alone can go quiet: a structural one over the source (no registration can skip
// the wrapper) and a behavioural one that actually calls every tool the registry projects for this server.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { listToolDefinitions } from "@loopover/contract/tools";
import { resolveErrorCode } from "@loopover/contract";

const recorded: Array<{ tool: string; ok: boolean; errorEnvelope?: { code: string; message: string } }> = [];

vi.mock("../../packages/loopover-miner/lib/mcp-dispatch-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/loopover-miner/lib/mcp-dispatch-telemetry")>();
  return {
    ...actual,
    recordMinerDispatchTelemetry: (call: { tool: string; ok: boolean; errorEnvelope?: { code: string; message: string } }) => {
      recorded.push({ tool: call.tool, ok: call.ok, ...(call.errorEnvelope ? { errorEnvelope: call.errorEnvelope } : {}) });
    },
  };
});

const SOURCE = readFileSync(join(process.cwd(), "packages/loopover-miner/bin/loopover-miner-mcp.ts"), "utf8");

describe("the miner's registrations are instrumented by construction (#9658)", () => {
  it("routes every registration through withMinerToolErrorHandling", () => {
    // Structural, and deliberately not a list of tool names: a rule that has to be extended per tool is a
    // rule someone forgets. Each `registerMinerTool(server, xTool, HANDLER)` is matched to the end of its
    // handler argument, and the handler must mention the wrapper.
    const registrations = [...SOURCE.matchAll(/registerMinerTool\(server,\s*(\w+),([\s\S]*?)\n\s*\);/g)];
    expect(registrations.length).toBeGreaterThan(15);

    const uninstrumented = registrations
      .filter(([, , handler]) => !handler!.includes("withMinerToolErrorHandling"))
      .map(([, tool]) => tool!);
    expect(uninstrumented, "these registrations bypass the dispatch-telemetry chokepoint").toEqual([]);
  });

  it("would catch a registration that bypassed it", () => {
    // The rule's own regex, against the exact shape it exists to reject -- otherwise a refactor could make
    // the pattern unmatchable and this suite would go quiet while reporting success.
    const bypassing = `registerMinerTool(server, minerPingTool, async () => minerToolResult(MINER_PING_STATUS),\n  );`;
    const [match] = [...bypassing.matchAll(/registerMinerTool\(server,\s*(\w+),([\s\S]*?)\n\s*\);/g)];
    expect(match, "the pattern still matches a real registration").toBeTruthy();
    expect(match![2]).not.toContain("withMinerToolErrorHandling");
  });

  it("records exactly one telemetry event per tool, for every tool the registry projects", async () => {
    const { createMinerMcpServer } = await import("../../packages/loopover-miner/bin/loopover-miner-mcp");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "miner-chokepoint", version: "0.0.0" });
    await Promise.all([
      // Every store-backed tool is left to fail against an absent store: this asserts INSTRUMENTATION, and a
      // failed call must be recorded exactly like a successful one.
      createMinerMcpServer({ dispatchAction: (async () => ({ ok: false, status: "handler_error", action: null })) as never }).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      // Derived from the registry, never a literal array -- a new miner tool joins this test by existing.
      const names = listToolDefinitions({ locality: ["miner"] }).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(15);

      for (const name of names) {
        recorded.length = 0;
        await client.callTool({ name, arguments: SMOKE_ARGUMENTS[name] ?? {} }).catch(() => undefined);
        expect(recorded.map((call) => call.tool), `${name} produced no dispatch-telemetry record`).toEqual([name]);
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  // #9659: the classification the caller is given is the one the event carries. The raw error used to be
  // handed to telemetry, where an ENOENT message matches /not found|no such/ -- so a store that would not
  // open told the caller `store_unavailable` and recorded `not_found`.
  it("records a store failure under the code the caller was given, not one re-read from the message", async () => {
    const { createMinerMcpServer } = await import("../../packages/loopover-miner/bin/loopover-miner-mcp");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "miner-store-failure", version: "0.0.0" });
    const initPortfolioQueue = () => {
      throw new Error("ENOENT: no such file or directory, open 'portfolio-queue.db'");
    };
    await Promise.all([
      createMinerMcpServer({ initPortfolioQueue: initPortfolioQueue as never }).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      recorded.length = 0;
      const result = (await client.callTool({ name: "loopover_miner_get_portfolio_dashboard", arguments: {} })) as {
        isError?: boolean;
        structuredContent?: { error?: { code?: string } };
      };
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error?.code, "what the caller is told").toBe("store_unavailable");
      expect(recorded[0]?.errorEnvelope?.code, "what telemetry records").toBe("store_unavailable");
      // And the message on its own would have been classified differently, which is the whole point.
      expect(resolveErrorCode(new Error("ENOENT: no such file or directory, open 'portfolio-queue.db'"))).toBe("not_found");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

/** The few tools with required inputs. Anything absent here takes `{}`, which is most of them. */
const SMOKE_ARGUMENTS: Record<string, Record<string, unknown>> = {
  loopover_miner_purge_repo: { repoFullName: "owner/repo", confirm: true },
  loopover_miner_queue_release: { repoFullName: "owner/repo", issueNumber: 1 },
  loopover_miner_queue_requeue: { repoFullName: "owner/repo", issueNumber: 1 },
  loopover_miner_claim_release: { repoFullName: "owner/repo", issueNumber: 1 },
  loopover_miner_deny_hooks_decide: { repoFullName: "owner/repo", hookId: "proposal-1", decision: "approve" },
  loopover_miner_get_plan: { planId: "plan-1" },
};
