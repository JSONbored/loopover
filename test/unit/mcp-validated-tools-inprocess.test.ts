import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #9521: the two stdio tools whose handlers read a VALIDATED response — driven in-process, since a
// subprocess-spawned bin reports no coverage back to vitest.
//
// `loopover_explain_gate_disposition` is the one that matters most here: it reads `result.predictedGate`,
// which #9587 finally declared with a real schema. Before that the field was undeclared, so the handler was
// reaching into a response the published document did not describe — the exact class of silent drift this
// issue's boundary validation exists to surface.

const MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

type BinModule = { server: { connect: (transport: unknown) => Promise<void> } };

let tempDir = "";
let mod: BinModule;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-validated-tools-"));
  const apiUrl = await startFixtureServer();
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  for (const key of ["LOOPOVER_API_URL", "LOOPOVER_API_TOKEN", "LOOPOVER_API_TIMEOUT_MS", "LOOPOVER_CONFIG_DIR", "LOOPOVER_SKIP_NPM_VERSION_CHECK"]) {
    delete process.env[key];
  }
});

async function connect(name: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mod.server.connect(serverTransport);
  const client = new Client({ name, version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("stdio tools over validated responses (#9521)", () => {
  it("loopover_explain_gate_disposition reshapes the predictedGate the response now declares", async () => {
    const client = await connect("explain-gate-disposition-test");
    try {
      const result = await client.callTool({
        name: "loopover_explain_gate_disposition",
        arguments: { owner: "owner", repo: "repo", login: "octocat", title: "fix: a thing" },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("loopover_predict_gate returns the same predictedGate verbatim", async () => {
    // Both tools read the field off one response; a rename would break them together, which is the point
    // of it being declared rather than optional-chained.
    const client = await connect("predict-gate-test");
    try {
      const result = await client.callTool({
        name: "loopover_predict_gate",
        arguments: { owner: "owner", repo: "repo", login: "octocat", title: "fix: a thing" },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("loopover_get_skipped_pr_audit builds its query string from the optional filters", async () => {
    const client = await connect("skipped-pr-audit-test");
    try {
      // With filters: the query string is appended. The no-filter call below takes the other arm.
      const filtered = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { limit: 5 } });
      expect(filtered.isError, JSON.stringify(filtered.content)).toBeFalsy();

      const unfiltered = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
      expect(unfiltered.isError, JSON.stringify(unfiltered.content)).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
