import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// (#7800) In-process coverage of the stdio loopover_get_gate_config_effective proxy. The bin ends with
// `await server.connect(new StdioServerTransport())` at module scope, so we mock StdioServerTransport to hand
// the imported module an in-memory transport we control, then drive its tool surface with a real MCP client.
// This is the only way to instrument bin/loopover-mcp.ts's new lines -- subprocess spawn (the sibling
// mcp-cli-pr-reviewability.test.ts) is functionally faithful but not coverage-instrumented.
const holder = vi.hoisted(() => ({ serverTransport: undefined as any }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    constructor() {
      return holder.serverTransport as any;
    }
  },
}));

const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let configDir: string;
let capturedRequests: Array<{ url: string; method: string }>;
const ENV_KEYS = ["LOOPOVER_CONFIG_DIR", "LOOPOVER_API_URL", "LOOPOVER_TOKEN", "LOOPOVER_API_TIMEOUT_MS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  configDir = mkdtempSync(join(tmpdir(), "loopover-gate-config-effective-"));
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/gate-config/effective")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  process.env.LOOPOVER_CONFIG_DIR = configDir;
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_TOKEN = "session-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "5000";

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  holder.serverTransport = serverTransport;

  // cliArgs[0] === undefined skips the module's `if (cliArgs[0] && cliArgs[0] !== "--stdio")` CLI-dispatch
  // guard (which would runCli + process.exit), so importing just registers the tools and connects our
  // in-memory transport instead of a real stdio one.
  const originalArgv = process.argv;
  process.argv = [process.execPath, "loopover-mcp"];
  // Import the .ts source explicitly (not the .js): a committed/build-artifact .js on disk would otherwise be
  // resolved and instrumented under its .js path, so codecov/patch would map the new lines to the wrong file.
  // A non-literal specifier keeps tsc from rejecting the .ts extension (TS5097) while vitest still loads it.
  const binTsModule = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
  await import(/* @vite-ignore */ binTsModule);
  process.argv = originalArgv;

  client = new Client({ name: "gate-config-effective-test", version: "0.0.1" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("loopover_get_gate_config_effective stdio proxy (#7800)", () => {
  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "loopover_get_gate_config_effective");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/gate thresholds/i);
  });

  it("proxies owner/repo to /gate-config/effective via apiGet and returns the payload", async () => {
    const result = await client.callTool({
      name: "loopover_get_gate_config_effective",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/repos/owner/repo/gate-config/effective");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("owner/repo");
    expect(text).toContain("confidenceFloor");
    expect(text).toContain("shadowPending");
  });
});
