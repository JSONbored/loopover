import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { setConfigAdminFunctions } from "../../src/mcp/private-config-admin-registry";
import { setLocalManifestReader } from "../../src/signals/focus-manifest-loader";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

const MCP_ADMIN_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp-admin" };
const MCP_ORDINARY_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp" };

async function connect(env: Env, identity: AuthIdentity = MCP_ADMIN_IDENTITY) {
  const server = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-admin-config-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  // Both registries are module-level singletons (#7721's own registry + the pre-existing focus-manifest
  // one), exactly like setLocalReviewContextReader elsewhere in this suite -- reset after every test so
  // one test's injected fakes can never leak into the next.
  setConfigAdminFunctions(null);
  setLocalManifestReader(null);
});

describe("MCP admin config tools: registration gating (#7721)", () => {
  it("are NOT registered at all when LOOPOVER_MCP_ADMIN_ENABLED is unset (default off)", async () => {
    const client = await connect(createTestEnv());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(["loopover_admin_get_config", "loopover_admin_write_config", "loopover_admin_list_config_backups"]));
  });

  it("are NOT registered when LOOPOVER_MCP_ADMIN_ENABLED is explicitly false-ish", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "false" }));
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith("loopover_admin_"))).toBe(false);
  });

  it("ARE registered, with the admin category, when LOOPOVER_MCP_ADMIN_ENABLED is truthy", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["loopover_admin_get_config", "loopover_admin_write_config", "loopover_admin_list_config_backups"]));
    for (const name of ["loopover_admin_get_config", "loopover_admin_write_config", "loopover_admin_list_config_backups"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect((tool._meta as { category?: string } | undefined)?.category).toBe("admin");
    }
  });
});

describe("MCP admin config tools: auth boundary (#7721)", () => {
  it("rejects the ordinary mcp actor even when the flag is on and the registry is configured", async () => {
    setConfigAdminFunctions({
      readGlobal: vi.fn(),
      readRepo: vi.fn(),
      writeGlobal: vi.fn(),
      writeRepo: vi.fn(),
      listBackups: vi.fn(),
    });
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" });
    const client = await connect(env, MCP_ORDINARY_IDENTITY);
    const result = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "global" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Forbidden/i);
  });

  it("rejects a session identity too -- this is a static-credential-only surface", async () => {
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" });
    const client = await connect(env, { kind: "session", actor: "some-login", session: {} as never });
    const result = await client.callTool({ name: "loopover_admin_list_config_backups", arguments: { scope: "global" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Forbidden/i);
  });
});

describe("MCP admin config tools: not-configured behavior (#7721)", () => {
  it("reports configured=false for get/write/list-backups when the registry has no injected functions", async () => {
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" });
    const client = await connect(env);
    const get = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "global" } });
    expect(get.isError).toBeFalsy();
    expect((get.structuredContent as { configured: boolean }).configured).toBe(false);

    const write = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "global", content: "gate:\n  mode: advisory\n" } });
    expect((write.structuredContent as { configured: boolean }).configured).toBe(false);

    const list = await client.callTool({ name: "loopover_admin_list_config_backups", arguments: { scope: "global" } });
    expect((list.structuredContent as { configured: boolean }).configured).toBe(false);
  });
});

describe("MCP admin config tools: get (#7721)", () => {
  it("global scope calls readGlobal and reports found=false when it returns null", async () => {
    const readGlobal = vi.fn().mockResolvedValue(null);
    setConfigAdminFunctions({ readGlobal, readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "global" } });
    expect(readGlobal).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ configured: true, found: false, path: null, content: null });
  });

  it("global scope returns the path+content readGlobal resolves", async () => {
    const readGlobal = vi.fn().mockResolvedValue({ path: ".loopover.yml", content: "gate:\n  mode: advisory\n" });
    setConfigAdminFunctions({ readGlobal, readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "global" } });
    expect(result.structuredContent).toMatchObject({ configured: true, found: true, path: ".loopover.yml", content: "gate:\n  mode: advisory\n" });
  });

  it("repo scope requires repoFullName and calls readRepo with it", async () => {
    const readRepo = vi.fn().mockResolvedValue({ path: "loopover/.loopover.yml", content: "gate:\n  mode: hold\n" });
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo, writeGlobal: vi.fn(), writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    const missingRepo = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "repo" } });
    expect(missingRepo.isError).toBe(true);

    const result = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "repo", repoFullName: "JSONbored/loopover" } });
    expect(readRepo).toHaveBeenCalledWith("JSONbored/loopover");
    expect(result.structuredContent).toMatchObject({ configured: true, found: true, path: "loopover/.loopover.yml" });
  });

  it("effective scope reuses the registered focus-manifest reader, not the admin registry's read functions", async () => {
    const readGlobal = vi.fn();
    setConfigAdminFunctions({ readGlobal, readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo: vi.fn(), listBackups: vi.fn() });
    setLocalManifestReader(async (repoFullName) => ({ content: `merged:${repoFullName}`, sharedConfigSource: null, warnings: [] }));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "effective", repoFullName: "JSONbored/loopover" } });
    expect(readGlobal).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ configured: true, found: true, content: "merged:JSONbored/loopover" });
  });

  it("effective scope reports found=false when no reader is registered", async () => {
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_get_config", arguments: { scope: "effective", repoFullName: "JSONbored/loopover" } });
    expect(result.structuredContent).toMatchObject({ found: false, content: null });
  });
});

describe("MCP admin config tools: write (#7721)", () => {
  it("dry run validates via the schema-aware validator WITHOUT calling the write function", async () => {
    const writeGlobal = vi.fn();
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal, writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "global", content: "gate:\n  mode: advisory\n", dryRun: true } });
    expect(writeGlobal).not.toHaveBeenCalled();
    // "warn" (not "ok"/"error") from the SAME richer, schema-aware validator loopover_validate_config uses
    // -- proves the real validator ran (a raw structural check would just say valid YAML, no opinion on
    // field names), not that this specific content is pristine.
    expect(result.structuredContent).toMatchObject({ configured: true, dryRun: true, status: "warn" });
  });

  it("dry run still runs even with an unconfigured registry (pure validation, no fs dependency)", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "global", content: "not: [valid", dryRun: true } });
    expect((result.structuredContent as { status: string }).status).toBe("error");
  });

  it("global write calls writeGlobal and surfaces its result", async () => {
    const writeGlobal = vi.fn().mockResolvedValue({ ok: true, path: ".loopover.yml", backupPath: null });
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal, writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "global", content: "gate:\n  mode: advisory\n" } });
    expect(writeGlobal).toHaveBeenCalledWith("gate:\n  mode: advisory\n");
    expect(result.structuredContent).toMatchObject({ configured: true, ok: true, path: ".loopover.yml", backupPath: null });
  });

  it("surfaces a failed write (e.g. invalid content caught by the real validator) without throwing", async () => {
    const writeGlobal = vi.fn().mockResolvedValue({ ok: false, error: "Content is empty." });
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal, writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "global", content: "" } });
    expect(result.isError).toBeFalsy(); // a rejected write is a normal tool result, not an MCP protocol error
    expect(result.structuredContent).toMatchObject({ configured: true, ok: false, error: "Content is empty." });
  });

  it("repo scope requires repoFullName and calls writeRepo with it", async () => {
    const writeRepo = vi.fn().mockResolvedValue({ ok: true, path: "loopover/.loopover.yml", backupPath: "loopover/.loopover.yml.bak-x" });
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo, listBackups: vi.fn() });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    const missingRepo = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "repo", content: "gate:\n  mode: advisory\n" } });
    expect(missingRepo.isError).toBe(true);

    const result = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "repo", repoFullName: "JSONbored/loopover", content: "gate:\n  mode: advisory\n" } });
    expect(writeRepo).toHaveBeenCalledWith("JSONbored/loopover", "gate:\n  mode: advisory\n");
    expect(result.structuredContent).toMatchObject({ ok: true, backupPath: "loopover/.loopover.yml.bak-x" });
  });
});

describe("MCP admin config tools: list backups (#7721)", () => {
  it("global scope calls listBackups with a global scope object", async () => {
    const listBackups = vi.fn().mockResolvedValue([{ name: ".loopover.yml.bak-x", path: ".loopover.yml.bak-x", mtimeMs: 123 }]);
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo: vi.fn(), listBackups });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_list_config_backups", arguments: { scope: "global" } });
    expect(listBackups).toHaveBeenCalledWith({ kind: "global" });
    expect((result.structuredContent as { backups: unknown[] }).backups).toHaveLength(1);
  });

  it("repo scope requires repoFullName and calls listBackups with a repo scope object", async () => {
    const listBackups = vi.fn().mockResolvedValue([]);
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo: vi.fn(), listBackups });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    const missingRepo = await client.callTool({ name: "loopover_admin_list_config_backups", arguments: { scope: "repo" } });
    expect(missingRepo.isError).toBe(true);

    await client.callTool({ name: "loopover_admin_list_config_backups", arguments: { scope: "repo", repoFullName: "JSONbored/loopover" } });
    expect(listBackups).toHaveBeenCalledWith({ kind: "repo", repoFullName: "JSONbored/loopover" });
  });
});
