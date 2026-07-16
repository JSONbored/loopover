import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

// An unreachable API endpoint with a tight timeout: if the stdio tool ever regressed to proxying over HTTP
// (`apiPost("/v1/lint/slop-risk", …)`) instead of computing in-process, every call below would error out
// against this dead address. Their success is what proves the local tool runs fully offline (#6267).
async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-check-slop-risk-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...(process.env as Record<string, string>),
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: "http://127.0.0.1:1",
      LOOPOVER_API_TIMEOUT_MS: "400",
    },
  });
  client = new Client({ name: "check-slop-risk-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_check_slop_risk stdio tool (#6267)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("advertises the in-process, no-round-trip behavior in the tool list", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_check_slop_risk");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("no API round-trip");
  });

  it("regression: flags a low-effort change with band/findings/rubric computed in-process, no network call", async () => {
    const result = await client.callTool({
      name: "loopover_check_slop_risk",
      arguments: {
        changedFiles: [{ path: "src/foo.ts", additions: 50, deletions: 0 }],
        description: "",
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      slopRisk: number;
      band: string;
      findings: { code: string }[];
      rubric: string;
    };
    // A code file with no test evidence (15) + an empty description (15) = 30 → "low".
    expect(data.slopRisk).toBe(30);
    expect(data.band).toBe("low");
    expect(data.findings.map((f) => f.code).sort()).toEqual(["empty_pr_description", "missing_test_evidence"]);
    // The local path keeps the /v1/lint/slop-risk route's `{ ...assessment, rubric }` shape byte-for-byte.
    expect(data.rubric).toContain("LoopOver slop assessment rubric");
  });

  it("returns a clean band with no findings offline for a substantive, well-described change", async () => {
    const result = await client.callTool({
      name: "loopover_check_slop_risk",
      arguments: {
        changedFiles: [
          { path: "src/foo.ts", additions: 40, deletions: 2 },
          { path: "test/unit/foo.test.ts", additions: 30, deletions: 0 },
        ],
        description: "Adds X to support Y because Z, with focused regression coverage.",
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { slopRisk: number; band: string; findings: unknown[] };
    expect(data.slopRisk).toBe(0);
    expect(data.band).toBe("clean");
    expect(data.findings).toEqual([]);
  });

  it("never leaks private financial terminology in the offline response", async () => {
    const result = await client.callTool({
      name: "loopover_check_slop_risk",
      arguments: { changedFiles: [{ path: "src/foo.ts", additions: 50, deletions: 0 }], description: "" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toMatch(/hotkey|coldkey|wallet|mnemonic|payout|reward|trust score/i);
  });
});
