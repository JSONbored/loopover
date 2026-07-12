import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClaimLedger } from "../../packages/gittensory-miner/lib/claim-ledger.js";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-feasibility-gate-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
    },
  });
  client = new Client({ name: "feasibility-gate-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("gittensory_feasibility_gate stdio tool (#4270)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_feasibility_gate");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("No API round-trip");
  });

  it("returns a go verdict for a clean, unclaimed, low-risk issue — with no network call", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toEqual({
      verdict: "go",
      avoidReasons: [],
      raiseReasons: [],
      summary: "Go: no blocking feasibility signal detected.",
    });
  });

  it("returns an avoid verdict when the issue is already solved", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "solved", duplicateClusterRisk: "none", issueStatus: "ready" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("avoid");
    expect(data.avoidReasons).toEqual(["claim_status_solved"]);
  });

  it("returns a raise verdict when found is explicitly false", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready", found: false },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("raise");
    expect(data.raiseReasons).toEqual(["target_not_found"]);
  });

  it("rejects an invalid duplicateClusterRisk enum value", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "unclaimed", duplicateClusterRisk: "extreme", issueStatus: "ready" },
    });
    expect(result.isError).toBe(true);
  });

  it("never leaks private financial terminology in the response", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "claimed", duplicateClusterRisk: "high", issueStatus: "duplicate" },
    });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/hotkey|coldkey|wallet|mnemonic|payout|reward/i);
  });
});

describe("gittensory_feasibility_gate: local claim-ledger sourcing (#5157)", () => {
  let ledgerRoot: string;
  let ledgerDbPath: string;
  let ledgerClient: Client;
  let ledgerTransport: StdioClientTransport;
  let ledgerConfigDir: string;

  async function connectWithLedgerDb(dbPath: string | undefined) {
    ledgerConfigDir = mkdtempSync(join(tmpdir(), "gittensory-feasibility-gate-ledger-"));
    const env: Record<string, string> = { ...(process.env as Record<string, string>), GITTENSORY_CONFIG_DIR: ledgerConfigDir };
    if (dbPath !== undefined) env.GITTENSORY_MINER_CLAIM_LEDGER_DB = dbPath;
    else delete env.GITTENSORY_MINER_CLAIM_LEDGER_DB;
    ledgerTransport = new StdioClientTransport({ command: "node", args: [bin, "--stdio"], env });
    ledgerClient = new Client({ name: "feasibility-gate-ledger-test", version: "0.0.1" });
    await ledgerClient.connect(ledgerTransport);
  }

  beforeEach(() => {
    ledgerRoot = mkdtempSync(join(tmpdir(), "gittensory-feasibility-gate-ledger-db-"));
    ledgerDbPath = join(ledgerRoot, "claim-ledger.sqlite3");
  });

  afterEach(async () => {
    await ledgerClient?.close().catch(() => undefined);
    if (ledgerConfigDir) rmSync(ledgerConfigDir, { recursive: true, force: true });
    if (ledgerRoot) rmSync(ledgerRoot, { recursive: true, force: true });
  });

  it("regression: prefers ledger-backed truth (claimed) over a contradicting caller-supplied claimStatus", async () => {
    const ledger = openClaimLedger(ledgerDbPath);
    ledger.claimIssue("acme/widgets", 42, "in progress");
    ledger.close();
    await connectWithLedgerDb(ledgerDbPath);

    const result = await ledgerClient.callTool({
      name: "gittensory_feasibility_gate",
      arguments: {
        claimStatus: "unclaimed", // caller-supplied, contradicts the real ledger state
        duplicateClusterRisk: "none",
        issueStatus: "ready",
        repoFullName: "acme/widgets",
        issueNumber: 42,
      },
    });
    expect(result.isError).toBeFalsy();
    // claimStatus: "claimed" triggers a "raise" verdict (claim_status_claimed) in the calculator -- the
    // important assertion is that THIS ran, not the "go" path the caller's "unclaimed" lie would have produced.
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("raise");
    expect(data.raiseReasons).toEqual(["claim_status_claimed"]);
  });

  it("sources claimStatus: unclaimed from the ledger when no active claim matches the issue, overriding a contradicting caller-supplied value", async () => {
    const ledger = openClaimLedger(ledgerDbPath);
    ledger.claimIssue("acme/widgets", 99, "someone else's issue"); // a DIFFERENT issue is claimed
    ledger.close();
    await connectWithLedgerDb(ledgerDbPath);

    const result = await ledgerClient.callTool({
      name: "gittensory_feasibility_gate",
      arguments: {
        claimStatus: "solved", // caller-supplied, would normally trigger an avoid verdict
        duplicateClusterRisk: "none",
        issueStatus: "ready",
        repoFullName: "acme/widgets",
        issueNumber: 42, // NOT the claimed issue -- ledger says unclaimed
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("go");
  });

  it("falls back to the caller-supplied claimStatus unchanged when the ledger DB file does not exist (no local install detected)", async () => {
    await connectWithLedgerDb(join(ledgerRoot, "does-not-exist.sqlite3"));

    const result = await ledgerClient.callTool({
      name: "gittensory_feasibility_gate",
      arguments: {
        claimStatus: "solved",
        duplicateClusterRisk: "none",
        issueStatus: "ready",
        repoFullName: "acme/widgets",
        issueNumber: 42,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("avoid");
    expect(data.avoidReasons).toEqual(["claim_status_solved"]);
  });

  it("falls back to the caller-supplied claimStatus unchanged when repoFullName/issueNumber are omitted", async () => {
    const ledger = openClaimLedger(ledgerDbPath);
    ledger.claimIssue("acme/widgets", 42, "irrelevant -- no repo/issue supplied");
    ledger.close();
    await connectWithLedgerDb(ledgerDbPath);

    const result = await ledgerClient.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "solved", duplicateClusterRisk: "none", issueStatus: "ready" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("avoid");
    expect(data.avoidReasons).toEqual(["claim_status_solved"]);
  });

  it("invariant: never writes to the claim ledger and never gains blocking/override authority (advisory-only output shape unchanged)", async () => {
    const setupLedger = openClaimLedger(ledgerDbPath);
    setupLedger.claimIssue("acme/widgets", 42, "pre-existing claim");
    const before = setupLedger.listClaims();
    setupLedger.close();
    await connectWithLedgerDb(ledgerDbPath);

    const result = await ledgerClient.callTool({
      name: "gittensory_feasibility_gate",
      arguments: {
        claimStatus: "unclaimed",
        duplicateClusterRisk: "none",
        issueStatus: "ready",
        repoFullName: "acme/widgets",
        issueNumber: 42,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["avoidReasons", "raiseReasons", "summary", "verdict"]);

    const inspectLedger = openClaimLedger(ledgerDbPath);
    const after = inspectLedger.listClaims();
    inspectLedger.close();
    expect(after).toEqual(before);
  });

  it("tool description documents the ledger-sourcing behavior and advisory-only guarantee", async () => {
    await connectWithLedgerDb(undefined);
    const { tools } = await ledgerClient.listTools();
    const tool = tools.find((t) => t.name === "gittensory_feasibility_gate");
    expect(tool?.description).toContain("Advisory-only");
    expect(tool?.description).toContain("local gittensory-miner install's claim ledger");
  });
});
