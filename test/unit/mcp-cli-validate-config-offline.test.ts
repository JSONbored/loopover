import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// #6269: loopover_validate_config now computes its result in-process via the extracted @loopover/engine
// builder (buildFocusManifestValidation) instead of POSTing to /v1/validate/focus-manifest. These tests drive
// the real local stdio server with a DELIBERATELY UNREACHABLE API URL to prove the tool validates fully offline
// -- if it still round-tripped to the API, every call here would fail/time out.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-validate-offline-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_TOKEN: "session-token",
      // Point the API at a black-holed port so any accidental round-trip would fail, not silently pass.
      LOOPOVER_API_URL: "http://127.0.0.1:1",
      LOOPOVER_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "validate-config-offline-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

function result(raw: unknown): { status: string; present: boolean; warnings: string[]; normalized: Record<string, unknown> } {
  return (raw as { structuredContent?: unknown }).structuredContent as {
    status: string;
    present: boolean;
    warnings: string[];
    normalized: Record<string, unknown>;
  };
}

describe("loopover_validate_config offline (#6269)", () => {
  it("validates a well-formed manifest in-process with no API round-trip", async () => {
    const raw = await client.callTool({
      name: "loopover_validate_config",
      arguments: { content: "wantedPaths:\n  - src/\n" },
    });
    expect(raw.isError).toBeFalsy();
    const r = result(raw);
    expect(r.status).toBe("ok");
    expect(r.present).toBe(true);
    expect(r.normalized).toMatchObject({ wantedPaths: ["src/"] });
  });

  it("warns on an unknown top-level field (the extracted config-lint path runs locally)", async () => {
    const raw = await client.callTool({
      name: "loopover_validate_config",
      arguments: { content: "gates:\n  linkedIssue: block\n" },
    });
    expect(raw.isError).toBeFalsy();
    const r = result(raw);
    expect(r.status).toBe("warn");
    expect(r.warnings.join("\n")).toMatch(/unknown top-level field/i);
  });

  it("reports error status for unparseable manifest content", async () => {
    const raw = await client.callTool({
      name: "loopover_validate_config",
      arguments: { content: "wantedPaths: [unterminated\n" },
    });
    expect(raw.isError).toBeFalsy();
    expect(result(raw).status).toBe("error");
  });
});
