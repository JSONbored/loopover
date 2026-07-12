import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  createMinerMcpServer,
  type MinerMcpServerOptions,
} from "../../packages/gittensory-miner/bin/gittensory-miner-mcp.js";

// Secret-shape matcher — kept in sync with scripts/check-miner-package.mjs's FORBIDDEN_CONTENT (the repo's
// existing secret detector for the miner package). Defined here rather than imported so this .ts test doesn't
// couple to that .mjs script's module surface.
const FORBIDDEN_CONTENT =
  /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=)/;

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
    valid: { initEventLedger: () => ({ dbPath: "", appendEvent: readThrows, readEvents: () => [], close() {} }) },
    missing: { initEventLedger: openerThrows },
    corrupt: { initEventLedger: () => ({ dbPath: "", appendEvent: readThrows, readEvents: readThrows, close() {} }) },
    excluded: ["payload_json"],
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
    valid: { initGovernorLedger: () => ({ readGovernorDecisions: () => [], close() {} }) },
    missing: { initGovernorLedger: openerThrows },
    corrupt: { initGovernorLedger: () => ({ readGovernorDecisions: readThrows, close() {} }) },
    excluded: ["payload", "payload_json"],
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
    expect(() => assertNoSecretShapedValue(withText(JSON.stringify({ token: "ghp_0123456789abcdefABCD" })))).toThrow();
  });

  it("assertNoExcludedColumn throws when an excluded column is present", () => {
    expect(() => assertNoExcludedColumn(withText(JSON.stringify({ payload_json: "x" })), ["payload_json"])).toThrow();
  });

  it("assertUniformErrorShape throws when a non-error (success) result is passed", () => {
    expect(() => assertUniformErrorShape({ content: [{ type: "text", text: "ok" }], isError: false })).toThrow();
  });
});
