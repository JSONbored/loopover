import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { loadOverride, writeLiveOverride, type StorageEnv } from "../../src/review/auto-apply";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-clear-selftune-override-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_clear_selftune_override (#8660)", () => {
  it("clears a repo's live self-tune override for an authorized caller and the override is gone afterward", async () => {
    const env = createTestEnv();
    const storageEnv = env as unknown as StorageEnv;
    await writeLiveOverride(storageEnv, REPO, { confidenceFloor: 0.42, scopeCap: { files: 5, lines: 200 } });
    // Guard the precondition: the override really is live before the tool runs.
    expect(await loadOverride(storageEnv, REPO)).not.toBeNull();

    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_clear_selftune_override", arguments: { owner: "owner", repo: "widgets", confirm: true } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ repoFullName: REPO, cleared: true });
    expect(JSON.stringify(result.content)).toContain("Cleared the live self-tune gate override for owner/widgets");

    // Deliverable (a): the override is verifiably gone via a direct store read.
    expect(await loadOverride(storageEnv, REPO)).toBeNull();
  });

  it("rejects a non-maintainer caller when the repo is not in MCP_ACTUATION_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    const storageEnv = env as unknown as StorageEnv;
    await writeLiveOverride(storageEnv, REPO, { confidenceFloor: 0.42 });

    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }
    const result = await client.callTool({ name: "loopover_clear_selftune_override", arguments: { owner: "owner", repo: "widgets", confirm: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);

    // Deliverable (b): the rejected call must not have touched the override.
    expect(await loadOverride(storageEnv, REPO)).not.toBeNull();
  });
});
