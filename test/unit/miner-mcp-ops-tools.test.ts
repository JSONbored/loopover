import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMinerMcpServer } from "../../packages/loopover-miner/bin/loopover-miner-mcp";
import type { MinerOpsActions } from "../../packages/loopover-miner/lib/chat-miner-ops-actions";

// #9523: the miner MCP's new tools, driven in-process over the in-memory transport.
//
// The mutating tools are registered against INJECTED ops actions and an injected dispatcher, so these cover
// the registration + result-shaping layer without touching a store or the real governor chokepoint — the
// gate itself, and the actions behind it, have their own suites
// (miner-mcp-governor-gating.test.ts, miner-ops-actions.test.ts).

type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  vi.restoreAllMocks();
});

function noopActions(): MinerOpsActions {
  return {
    releaseQueueItem: () => ({ released: true }),
    requeueQueueItem: () => ({ requeued: true }),
    releaseClaim: () => ({ released: true }),
    decideDenyHook: () => ({ decided: true }),
    runMigrations: () => ({ ok: true, stores: [] }),
    purgeRepo: () => ({ outcome: "purged", totalPurged: 0 }),
  };
}

/** `dispatchChatAction`'s result shape — the tools only ever see this, never a store. */
type DispatchResult = { ok: boolean; status?: string; action?: string | null; error?: string; result?: unknown };

async function connect(options: Parameters<typeof createMinerMcpServer>[0] = {}) {
  const server = createMinerMcpServer({ opsActions: noopActions(), ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "miner-ops-tools-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

function structured(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe("loopover_miner_doctor (#9523)", () => {
  it("maps status.js's {name, ok, detail} checks onto the contract's pass/fail vocabulary", async () => {
    const client = await connect({
      runDoctorChecks: () => [
        { name: "state-dir", ok: true, detail: "present" },
        { name: "engine-version", ok: false, detail: "mismatch" },
      ],
    });
    const result = structured((await client.callTool({ name: "loopover_miner_doctor", arguments: {} })) as ToolResult);
    expect(result.ok, "any failing check clears ok").toBe(false);
    expect(result.checks).toEqual([
      { name: "state-dir", status: "pass", detail: "present" },
      { name: "engine-version", status: "fail", detail: "mismatch" },
    ]);
  });

  it("reports ok when every check passes, and runs them ALL rather than stopping at the first", async () => {
    const client = await connect({ runDoctorChecks: () => [{ name: "a", ok: true, detail: "" }, { name: "b", ok: true, detail: "" }] });
    const result = structured((await client.callTool({ name: "loopover_miner_doctor", arguments: {} })) as ToolResult);
    expect(result.ok).toBe(true);
    expect((result.checks as unknown[]).length).toBe(2);
  });

  it("falls back to status.js's real runDoctorChecks when none is injected", async () => {
    // The default arm every real deployment takes; a test host simply reports failing checks.
    const server = createMinerMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "default-doctor", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    clients.push(client);
    const result = (await client.callTool({ name: "loopover_miner_doctor", arguments: {} })) as ToolResult;
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(Array.isArray(structured(result).checks)).toBe(true);
  });

  it("surfaces a doctor that throws as a tool error rather than a false clean bill", async () => {
    const client = await connect({
      runDoctorChecks: () => {
        throw new Error("state dir unreadable");
      },
    });
    const result = (await client.callTool({ name: "loopover_miner_doctor", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
  });
});

describe("loopover_miner_get_metrics_snapshot (#9523)", () => {
  it("returns the SAME families the Prometheus scrape renders", async () => {
    const client = await connect({
      initPredictionLedger: () => ({
        // The ledger's own row shape: toPredictionRecords reads `conclusion`/`targetId`/`ts`, so a fixture
        // shaped like the DOWNSTREAM record silently yields conclusion: undefined.
        readPredictions: () => [
          { repoFullName: "owner/repo", targetId: 1, conclusion: "merge", ts: "2026-07-01T00:00:00.000Z" },
          { repoFullName: "owner/repo", targetId: 2, conclusion: "close", ts: "2026-07-01T00:00:00.000Z" },
        ] as never,
        close: () => undefined,
      }),
      initEventLedger: () => ({ readEvents: () => [], close: () => undefined }) as never,
    });
    const raw = (await client.callTool({ name: "loopover_miner_get_metrics_snapshot", arguments: {} })) as ToolResult;
    expect(raw.isError, JSON.stringify(raw.content)).toBeFalsy();
    const result = structured(raw);
    expect(typeof result.generatedAt).toBe("string");
    const families = result.families as Array<{ name: string; samples: unknown[] }>;
    expect(families.map((family) => family.name)).toEqual([
      "loopover_miner_predictions_total",
      "loopover_miner_prediction_correct_total",
      "loopover_miner_prediction_incorrect_total",
    ]);
    // One series per predicted conclusion, sorted — the aggregation is shared, so this is the scrape's shape.
    expect(families[0]!.samples).toEqual([
      { value: 1, labels: { conclusion: "close" } },
      { value: 1, labels: { conclusion: "merge" } },
    ]);
  });

  it("opens and closes its OWN ledgers when neither is injected", async () => {
    // The default path: the tool owns both handles and must close what it opened, since the miner is a CLI
    // rather than a daemon holding them open.
    const client = await connect();
    const result = (await client.callTool({ name: "loopover_miner_get_metrics_snapshot", arguments: {} })) as ToolResult;
    // A test host has no real ledgers, so this may answer either way — what matters is that it does not hang
    // or leak, and that the un-injected branch is the one taken.
    expect(result).toBeTruthy();
  });

  it("surfaces a ledger that will not open as isError rather than an SDK schema rejection", async () => {
    const client = await connect({
      initPredictionLedger: () => {
        throw new Error("prediction ledger unreadable");
      },
    });
    const result = (await client.callTool({ name: "loopover_miner_get_metrics_snapshot", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(structured(result).error).toMatchObject({ message: "prediction ledger unreadable" });
  });

  it("emits every counter even for an empty ledger, so the surface is well-formed before any prediction", async () => {
    const client = await connect({
      initPredictionLedger: () => ({ readPredictions: () => [], close: () => undefined }) as never,
      initEventLedger: () => ({ readEvents: () => [], close: () => undefined }) as never,
    });
    const result = structured((await client.callTool({ name: "loopover_miner_get_metrics_snapshot", arguments: {} })) as ToolResult);
    expect((result.families as unknown[]).length).toBe(3);
  });
});

describe("the mutating tools shape their dispatch result (#9523)", () => {
  /** A dispatcher that always allows, capturing what each tool asked for. */
  function allowing(calls: Array<{ action?: string; params?: unknown }>) {
    return (async (request: { action?: string; params?: unknown }): Promise<DispatchResult> => {
      calls.push(request);
      return { ok: true, action: request.action ?? null, result: { done: true } };
    }) as never;
  }

  it.each([
    ["loopover_miner_governor_pause", { reason: "incident" }, "governor_pause"],
    ["loopover_miner_governor_resume", {}, "governor_resume"],
    ["loopover_miner_queue_release", { repoFullName: "owner/repo", issueNumber: 1 }, "miner_queue_release"],
    ["loopover_miner_queue_requeue", { repoFullName: "owner/repo", issueNumber: 2 }, "miner_queue_requeue"],
    ["loopover_miner_claim_release", { repoFullName: "owner/repo", issueNumber: 3 }, "miner_claim_release"],
    ["loopover_miner_deny_hooks_decide", { repoFullName: "owner/repo", hookId: "h", decision: "approve" }, "miner_deny_hooks_decide"],
    ["loopover_miner_run_migrations", {}, "miner_run_migrations"],
    ["loopover_miner_purge_repo", { repoFullName: "owner/repo", confirm: true }, "miner_purge_repo"],
  ])("%s dispatches the %s action", async (tool, args, expectedAction) => {
    const calls: Array<{ action?: string; params?: unknown }> = [];
    const client = await connect({ dispatchAction: allowing(calls) });
    const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(structured(result).ok).toBe(true);
    expect(calls.map((call) => call.action)).toEqual([expectedAction]);
  });

  it("omits an absent pause reason rather than sending an empty one", async () => {
    const calls: Array<{ action?: string; params?: unknown }> = [];
    const client = await connect({ dispatchAction: allowing(calls) });
    await client.callTool({ name: "loopover_miner_governor_pause", arguments: {} });
    expect(calls[0]!.params).toEqual({});
  });

  it("echoes the repo back on a purge, so the report names what was purged", async () => {
    const calls: Array<{ action?: string; params?: unknown }> = [];
    const client = await connect({ dispatchAction: allowing(calls) });
    const result = structured((await client.callTool({ name: "loopover_miner_purge_repo", arguments: { repoFullName: "owner/repo", confirm: true } })) as ToolResult);
    expect(result.repoFullName).toBe("owner/repo");
  });

  it("REPORTS a governor refusal as a blocked result rather than throwing", async () => {
    // A refusal is an ANSWER the caller needs to see; a thrown error would flatten it into a generic
    // tool failure with no reason attached.
    // #9659: a REAL refusal status. The dispatcher's outcomes are a closed union now, and this fixture used
    // to invent one ("blocked_by_governor") that `dispatchChatAction` cannot return -- so the case proved
    // the shaping worked for a status that does not exist.
    const dispatchAction = (async () => ({ ok: false, status: "handler_error", action: "miner_purge_repo" })) as never;
    const client = await connect({ dispatchAction });
    const result = (await client.callTool({ name: "loopover_miner_purge_repo", arguments: { repoFullName: "owner/repo", confirm: true } })) as ToolResult;
    expect(result.isError, "a refusal is not a transport failure").toBeFalsy();
    expect(structured(result)).toMatchObject({ ok: false, blocked: true, reason: "handler_error" });
    // The refusal carries the shared envelope, under the code its status maps to.
    expect(structured(result).error).toEqual({ code: "upstream_error", message: "handler_error" });
  });

  it("carries the dispatcher's own error text through when it supplies one", async () => {
    const dispatchAction = (async () => ({ ok: false, status: "invalid_params", action: "miner_queue_release", error: "issueNumber must be positive" })) as never;
    const client = await connect({ dispatchAction });
    const result = structured(
      (await client.callTool({ name: "loopover_miner_queue_release", arguments: { repoFullName: "owner/repo", issueNumber: 1 } })) as ToolResult,
    );
    // #9659: the detail now travels inside the shared envelope rather than as a bare `error` string, so
    // one field name means one thing on every LoopOver server.
    expect(result).toMatchObject({ blocked: true, reason: "invalid_params", error: { code: "invalid_input", message: "issueNumber must be positive" } });
  });

  it("falls back to unknown_error for a status outside the dispatcher's closed set", async () => {
    // `dispatchAction` is an injection seam and the chat-action registry is populated at runtime, so a
    // status the union does not name is reachable even though it is not writable in typed code. It must
    // still produce a valid envelope rather than an unparseable code.
    const dispatchAction = (async () => ({ ok: false, status: "something_new", action: "miner_queue_release", error: "detail" })) as never;
    const client = await connect({ dispatchAction });
    const result = structured(
      (await client.callTool({ name: "loopover_miner_queue_release", arguments: { repoFullName: "owner/repo", issueNumber: 1 } })) as ToolResult,
    );
    expect(result.error).toEqual({ code: "unknown_error", message: "detail" });
  });

  it("REGRESSION: rejects a purge whose confirm is absent, before any dispatch happens", async () => {
    // `confirm` is z.literal(true) precisely so an omitted field cannot read as false and proceed.
    const calls: Array<{ action?: string; params?: unknown }> = [];
    const client = await connect({ dispatchAction: allowing(calls) });
    const result = (await client.callTool({ name: "loopover_miner_purge_repo", arguments: { repoFullName: "owner/repo" } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(calls, "a schema rejection must not reach the dispatcher").toEqual([]);
  });

  it("REGRESSION: rejects confirm:false as firmly as an omitted one", async () => {
    const calls: Array<{ action?: string; params?: unknown }> = [];
    const client = await connect({ dispatchAction: allowing(calls) });
    const result = (await client.callTool({ name: "loopover_miner_purge_repo", arguments: { repoFullName: "owner/repo", confirm: false } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("wires the REAL store actions when none are injected", async () => {
    // The default arm: createMinerOpsActions() against the on-disk stores. Registration alone opens nothing,
    // so this only proves the un-injected branch is taken and the tools still register.
    const server = createMinerMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "default-ops-actions", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("loopover_miner_purge_repo");
  });

  it("registers the governor pause/resume chat actions when the clients are supplied", async () => {
    // The governor pair registers from its own module; supplying the clients is what wires it up.
    const calls: Array<{ action?: string; params?: unknown }> = [];
    const client = await connect({
      dispatchAction: allowing(calls),
      governorClients: { pauseGovernor: async () => ({ paused: true }), resumeGovernor: async () => ({ paused: false }) },
    });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("loopover_miner_governor_pause");
  });
});
