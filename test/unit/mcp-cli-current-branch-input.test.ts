// REGRESSION: the stdio branch tools must not demand a login the CLI resolves itself (#10034).
//
// LocalBranchAnalysisInput made `login`/`repoFullName` required so the REMOTE server (which has no
// checkout) could advertise the full vocabulary a caller may supply. The eight stdio registrations
// of that contract never narrowed back down, so `tools/list` advertised the same required fields the
// remote does, even though the stdio handler resolves both from the active session / checkout and
// never needs them. Same in-process InMemoryTransport pattern as test/contract/validate-mcp.test.ts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const STDIO_LOCAL_BRANCH_TOOL_NAMES = [
  "loopover_preflight_current_branch",
  "loopover_preview_current_branch_score",
  "loopover_rank_local_next_actions",
  "loopover_explain_local_blockers",
  "loopover_remediation_plan",
  "loopover_prepare_pr_packet",
  "loopover_draft_pr_body",
  "loopover_agent_prepare_pr_packet",
] as const;

// The bin lives at ../../packages/loopover-mcp/bin/loopover-mcp.ts. Routed through a variable
// (rather than a literal import(".../loopover-mcp.ts")) because tsc's `--noEmit` root build rejects
// a literal `.ts`-suffixed specifier without `allowImportingTsExtensions` -- same indirection
// test/unit/mcp-cli-contributor-profile-inprocess.test.ts uses for the same reason.
const BIN_MODULE_SPECIFIER = ["..", "..", "packages", "loopover-mcp", "bin", "loopover-mcp.ts"].join("/");

type BinModule = { server: { connect: (transport: unknown) => Promise<void> } };

let tempDir = "";
let mod: BinModule;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-current-branch-input-"));
  const apiUrl = await startFixtureServer();
  // The bin reads LOOPOVER_API_URL at module load, so set the env BEFORE importing (hence the dynamic import).
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(BIN_MODULE_SPECIFIER)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("REGRESSION: the stdio branch tools must not demand a login the CLI resolves itself (#10034)", () => {
  it("advertises no required login/repoFullName for any of the eight local-branch tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "current-branch-input-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of STDIO_LOCAL_BRANCH_TOOL_NAMES) {
        const tool = byName.get(name);
        expect(tool, name).toBeDefined();
        const required = (tool!.inputSchema as { required?: string[] }).required ?? [];
        expect(required, name).not.toContain("login");
        expect(required, name).not.toContain("repoFullName");
      }
      // loopover_draft_pr_body's narrowing must not have dropped `format` along the way.
      const draftPrBody = byName.get("loopover_draft_pr_body");
      const properties = Object.keys((draftPrBody!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(properties).toContain("format");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("still reaches the handler with no login/repoFullName — schema validation no longer rejects the ordinary call", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "current-branch-input-empty-call-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      // Called from a non-git tempDir: with the narrowing restored, the SDK's own schema check no
      // longer rejects this at -32602 for a missing `login`/`repoFullName` -- it reaches the handler,
      // which then fails for the unrelated, expected reason that tempDir is not a git checkout.
      let threwProtocolError = false;
      try {
        await client.callTool({ name: "loopover_preflight_current_branch", arguments: { cwd: tempDir } });
      } catch (error) {
        threwProtocolError = error instanceof Error && /-32602/.test(error.message);
      }
      expect(threwProtocolError).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
