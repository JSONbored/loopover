import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  createMinerMcpServer,
  type MinerMcpServerOptions,
} from "../../packages/gittensory-miner/bin/gittensory-miner-mcp.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
// The SAME secret-shape matcher the miner pack validator uses — imported from its single source of truth (rather
// than hand-duplicated here) so the two stay byte-for-byte in sync instead of relying on manual vigilance.
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content.mjs";

// Shared contract/parity suite (#5199) across every read-only AMS MCP tool — mirrors the spirit of the engine's
// driver-parity suite (#4296). One parameterized table enforces, for ALL tools at once, the invariants that
// matter: a valid response leaks no secret-shaped value and no explicitly-excluded raw column, and a
// missing/corrupt backing store yields a UNIFORM error shape rather than a bespoke one or a crash. This does not
// replace each tool's own tests — it is a shared safety net layered on top of them (and adding a new tool costs
// one table row, not new assertion code).

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

async function invoke(options: MinerMcpServerOptions, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-contract", version: "0.0.0" });
  await Promise.all([createMinerMcpServer(options).connect(serverTransport), client.connect(clientTransport)]);
  return (await client.callTool({ name: tool, arguments: args })) as ToolResult;
}

// The tool's data is carried as a JSON string inside each content block's `text`, so inspect that inner payload
// (not the outer envelope, where the keys/values would be escaped).
const responseText = (result: ToolResult): string => result.content.map((block) => block.text ?? "").join("\n");

// --- The three shared contract assertions. Their catch-a-violation behavior is proven by the canary block below,
//     so they cannot silently regress to a no-op. ---

/** Reuses the pack validator's exact secret-shape matcher (no second detector that could drift). */
function assertNoSecretShapedValue(result: ToolResult): void {
  expect(FORBIDDEN_CONTENT.test(responseText(result))).toBe(false);
}

function assertNoExcludedColumn(result: ToolResult, excluded: readonly string[]): void {
  const text = responseText(result);
  for (const key of excluded) expect(text).not.toContain(`"${key}"`);
}

function assertUniformErrorShape(result: ToolResult): void {
  expect(result.isError).toBe(true);
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  expect(typeof result.content[0]?.text).toBe("string");
}

/** A store opener that fails as if the ledger/store file were missing or unreadable. */
function openerThrows(): never {
  throw new Error("store_unavailable");
}
const readThrows = (): never => {
  throw new Error("corrupt_store");
};

// A secret-SHAPED value planted in the RAW backing data for the redacting tools (audit-feed, governor). It matches
// the shared FORBIDDEN_CONTENT detector via its generic `<NAME>_TOKEN=` branch (deliberately NOT a real GitHub-PAT
// shape, so it can't read as an actual leaked credential). Because each tool projects to a metadata-only shape this
// must never reach the response — so the `valid` assertions are real regression guards (they'd fail if a projection
// ever widened to spread the raw row), not vacuous no-ops on an empty fixture.
const PLANTED_SECRET = "EXAMPLE_TOKEN=not-a-real-secret";

// The governor tool's redaction lives INSIDE the ledger's readGovernorDecisions (the injected seam), so a fake
// ledger would bypass it. Drive the `valid` case against a REAL temp ledger seeded with sensitive payload, exactly
// like miner-mcp-governor-decisions.test.ts — the exclusion assertion then exercises the actual named-column SQL.
const governorRoots: string[] = [];
function seededGovernorLedger(): ReturnType<typeof initGovernorLedger> {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-mcp-contract-governor-"));
  governorRoots.push(root);
  const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  ledger.appendGovernorEvent({
    eventType: "denied",
    repoFullName: "acme/api",
    actionClass: "write",
    decision: "block",
    reason: "house rule violation",
    // Sensitive state that must never surface through the read tool (mirrors #5134's payload growth).
    payload: { reputation: 0.2, self_plagiarism: true, budget: { remaining: 0 }, token: PLANTED_SECRET },
  });
  return ledger;
}
const seededGovernor = seededGovernorLedger();
afterAll(() => {
  seededGovernor.close();
  for (const root of governorRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// One row per read-only tool. `valid` returns a benign store, `missing` an opener that throws, `corrupt` a store
// whose read throws. Adding a new read-only tool = adding a row here (req 5), never new assertion code.
type ToolContract = {
  tool: string;
  args: Record<string, unknown>;
  valid: MinerMcpServerOptions;
  missing: MinerMcpServerOptions;
  corrupt: MinerMcpServerOptions;
  excluded: string[];
};

const READ_ONLY_TOOLS: ToolContract[] = [
  {
    tool: "gittensory_miner_status",
    args: {},
    valid: {
      collectStatus: () => ({
        package: { name: "@jsonbored/gittensory-miner", version: "0.1.0" },
        engine: { name: "@jsonbored/gittensory-engine", version: "1.0.0" },
        node: "v22.13.0",
        stateDir: "/home/miner/.config/gittensory-miner",
        configFile: null,
        driver: { provider: "claude-code", modelEnvVar: "MINER_CODING_AGENT_CLAUDE_MODEL", cliPresent: true },
      }),
      runDoctorChecks: () => [{ name: "Node", ok: true, detail: "v22.13.0" }],
    },
    missing: { collectStatus: openerThrows, runDoctorChecks: () => [] },
    corrupt: { collectStatus: () => ({}), runDoctorChecks: readThrows },
    excluded: [],
  },
  {
    tool: "gittensory_miner_get_portfolio_dashboard",
    args: {},
    valid: { initPortfolioQueue: () => ({ listQueue: () => [], close() {} }) },
    missing: { initPortfolioQueue: openerThrows },
    corrupt: { initPortfolioQueue: () => ({ listQueue: readThrows, close() {} }) },
    excluded: [],
  },
  {
    tool: "gittensory_miner_list_claims",
    args: {},
    valid: { openClaimLedger: () => ({ listClaims: () => [], close() {} }) },
    missing: { openClaimLedger: openerThrows },
    corrupt: { openClaimLedger: () => ({ listClaims: readThrows, close() {} }) },
    excluded: [],
  },
  {
    tool: "gittensory_miner_get_audit_feed",
    args: {},
    // Seed a RAW ledger entry carrying a full payload (secret-shaped token + sensitive keys). The tool runs the
    // real collectEventLedgerAuditFeed projection over it, which must reduce each row to metadata only
    // (eventType/repoFullName/outcome/actor/detail/createdAt) — so none of the excluded keys nor the token survive.
    valid: {
      initEventLedger: () => ({
        dbPath: "",
        appendEvent: readThrows,
        readEvents: () => [
          {
            id: 1,
            seq: 1,
            type: "attempt.completed",
            repoFullName: "acme/widgets",
            payload: { outcome: "merged", actor: "miner", detail: "ok", token: PLANTED_SECRET, payload_json: "raw" },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        close() {},
      }),
    },
    missing: { initEventLedger: openerThrows },
    corrupt: { initEventLedger: () => ({ dbPath: "", appendEvent: readThrows, readEvents: readThrows, close() {} }) },
    excluded: ["payload", "payload_json", "token"],
  },
  {
    tool: "gittensory_miner_get_run_state",
    args: {},
    valid: { initRunStateStore: () => ({ getRunState: () => null, listRunStates: () => [], close() {} }) },
    missing: { initRunStateStore: openerThrows },
    corrupt: { initRunStateStore: () => ({ getRunState: readThrows, listRunStates: readThrows, close() {} }) },
    excluded: [],
  },
  {
    tool: "gittensory_miner_list_plans",
    args: {},
    valid: { openPlanStore: () => ({ loadPlan: () => null, listPlans: () => [], close() {} }) },
    missing: { openPlanStore: openerThrows },
    corrupt: { openPlanStore: () => ({ loadPlan: () => null, listPlans: readThrows, close() {} }) },
    excluded: [],
  },
  {
    tool: "gittensory_miner_get_plan",
    args: { planId: "p1" },
    valid: { openPlanStore: () => ({ loadPlan: () => null, listPlans: () => [], close() {} }) },
    missing: { openPlanStore: openerThrows },
    corrupt: { openPlanStore: () => ({ loadPlan: readThrows, listPlans: () => [], close() {} }) },
    excluded: [],
  },
  {
    tool: "gittensory_miner_get_governor_decisions",
    args: {},
    // Real temp ledger (seeded above) so the redaction assertion exercises the actual explicit-named-column SQL —
    // it must fail if a future edit widens the SELECT to include payload_json.
    valid: { initGovernorLedger: () => seededGovernor },
    missing: { initGovernorLedger: openerThrows },
    corrupt: { initGovernorLedger: () => ({ readGovernorDecisions: readThrows, close() {} }) },
    excluded: ["payload", "payload_json", "reputation", "self_plagiarism", "budget"],
  },
];

describe("read-only AMS MCP tool contract (#5199)", () => {
  for (const entry of READ_ONLY_TOOLS) {
    describe(entry.tool, () => {
      it("a valid response leaks no secret-shaped value and no excluded raw column", async () => {
        const result = await invoke(entry.valid, entry.tool, entry.args);
        expect(result.isError ?? false).toBe(false);
        assertNoSecretShapedValue(result);
        assertNoExcludedColumn(result, entry.excluded);
      });

      it("returns a uniform error shape when its backing store is missing", async () => {
        assertUniformErrorShape(await invoke(entry.missing, entry.tool, entry.args));
      });

      it("returns a uniform error shape when its backing store is corrupt", async () => {
        assertUniformErrorShape(await invoke(entry.corrupt, entry.tool, entry.args));
      });
    });
  }
});

// Canary: prove each contract assertion actually CATCHES a violation, so a future change can't quietly turn one
// into a no-op (a green suite that checks nothing).
describe("contract assertions catch violations (canary)", () => {
  const withText = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

  it("assertNoSecretShapedValue throws on a token-shaped value", () => {
    expect(() => assertNoSecretShapedValue(withText(JSON.stringify({ token: PLANTED_SECRET })))).toThrow();
  });

  it("assertNoExcludedColumn throws when an excluded column is present", () => {
    expect(() => assertNoExcludedColumn(withText(JSON.stringify({ payload_json: "x" })), ["payload_json"])).toThrow();
  });

  it("assertUniformErrorShape throws when a non-error (success) result is passed", () => {
    expect(() => assertUniformErrorShape({ content: [{ type: "text", text: "ok" }], isError: false })).toThrow();
  });
});
