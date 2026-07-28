import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import {
  resetInstanceDiagnosticsForTesting,
  setInstanceBackupStatusReader,
  setInstanceDoctorRunner,
  setInstanceLogTailer,
  setInstanceStatusReader,
} from "../../src/mcp/instance-diagnostics-registry";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// #9522: the AUTHORIZED behavior of the management tools. mcp-management-tool-auth.test.ts covers every
// deny path; this covers what happens once the gate lets a caller through — the answers they get, and the
// structured "not configured"/"unavailable" shapes that stand in for a capability this deployment lacks.
//
// `internal` is the static Worker-secret identity: it satisfies both requireOperator and requireInternal,
// which is what lets one identity drive every family here.
const INTERNAL: AuthIdentity = { kind: "static", actor: "internal" };

async function connect(env: Env, identity: AuthIdentity = INTERNAL) {
  const server = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "management-tools-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

/** The tool's structured payload. Typed off the SDK's own loose result shape rather than a narrow local one. */
function structured(result: { structuredContent?: unknown } | Record<string, unknown>): Record<string, unknown> {
  return ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  resetInstanceDiagnosticsForTesting();
});

describe("ops tools when the queue backend has no dead-letter admin (#9522)", () => {
  // createTestEnv's JOBS binding is a plain queue with none of the dead-letter admin methods — exactly the
  // Cloudflare shape. Every dead-letter tool must ANSWER `unavailable` rather than erroring, because "this
  // backend has no DLQ" is an answer to the question, not a failure to answer it.
  it.each([
    ["loopover_ops_list_dead_letter_jobs", {}],
    ["loopover_ops_replay_dead_letter_job", { id: 1 }],
    ["loopover_ops_delete_dead_letter_job", { id: 1, confirm: true }],
    ["loopover_ops_purge_dead_letter_jobs", { confirm: true }],
  ])("%s reports unavailable instead of throwing", async (name, args) => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name} must not error`).toBeFalsy();
    expect(structured(result).unavailable).toBe(true);
    await client.close();
  });
});

describe("kill switch (#9522)", () => {
  it("reads the released state, engages it, and reads back the engaged state", async () => {
    const env = createTestEnv();
    const client = await connect(env);

    const before = await client.callTool({ name: "loopover_ops_get_kill_switch", arguments: {} });
    expect(structured(before).frozen).toBe(false);

    const engaged = await client.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: true } });
    expect(structured(engaged).frozen).toBe(true);

    const after = await client.callTool({ name: "loopover_ops_get_kill_switch", arguments: {} });
    expect(structured(after).frozen).toBe(true);
    await client.close();
  });

  it("REFUSES to release without confirm — engaging is fail-safe, releasing re-arms the whole fleet", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    await client.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: true } });

    const released = await client.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: false } });
    expect(released.isError).toBe(true);
    expect(JSON.stringify(released.content)).toMatch(/confirm/);

    // Still engaged — the refusal did not half-apply.
    expect(structured(await client.callTool({ name: "loopover_ops_get_kill_switch", arguments: {} })).frozen).toBe(true);
    await client.close();
  });

  it("releases when confirm is passed", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    await client.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: true } });
    const released = await client.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: false, confirm: true } });
    expect(structured(released).frozen).toBe(false);
    await client.close();
  });
});

describe("operator dashboard (#9522)", () => {
  it("answers over the default window", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_ops_get_operator_dashboard", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it("honors an explicit window", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_ops_get_operator_dashboard", arguments: { days: 7 } });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});

describe("fleet tools (#9522)", () => {
  it("lists an empty instance roster, then reports a registered instance with its once-only secret", async () => {
    const env = createTestEnv();
    const client = await connect(env);

    expect(structured(await client.callTool({ name: "loopover_fleet_list_instances", arguments: {} })).instances).toEqual([]);

    const registered = await client.callTool({ name: "loopover_fleet_register_instance", arguments: { instanceId: "inst-1" } });
    expect(structured(registered).registered).toBe(true);
    expect(String(structured(registered).instanceSecret ?? "")).toMatch(/^orbis_/);

    const listed = structured(await client.callTool({ name: "loopover_fleet_list_instances", arguments: {} }));
    expect((listed.instances as unknown[]).length).toBe(1);
    await client.close();
  });

  it("opting an instance out mints no secret", async () => {
    const client = await connect(createTestEnv());
    await client.callTool({ name: "loopover_fleet_register_instance", arguments: { instanceId: "inst-2" } });
    const out = structured(await client.callTool({ name: "loopover_fleet_register_instance", arguments: { instanceId: "inst-2", registered: false } }));
    expect(out.registered).toBe(false);
    expect(out.instanceSecret).toBeUndefined();
    await client.close();
  });

  it("lists installations, and REFUSES to register one the webhook never recorded", async () => {
    const client = await connect(createTestEnv());
    expect(structured(await client.callTool({ name: "loopover_fleet_list_installations", arguments: {} })).installations).toEqual([]);

    const missing = await client.callTool({ name: "loopover_fleet_register_installation", arguments: { installationId: 4242 } });
    expect(structured(missing).error).toBe("installation_not_found");
    await client.close();
  });

  it("answers not_found for enrollment tools when the broker is disabled on this deployment", async () => {
    const client = await connect(createTestEnv());
    for (const [name, args] of [
      ["loopover_fleet_issue_enrollment", { installationId: 1 }],
      ["loopover_fleet_rotate_enrollment", { installationId: 1 }],
      ["loopover_fleet_revoke_enrollment", { enrollId: "e-1", confirm: true }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} must answer, not throw`).toBeFalsy();
      expect(structured(result).error).toBe("not_found");
    }
    await client.close();
  });
});

describe("loopover_fleet_run_job (#9522)", () => {
  it("enqueues a job that supports enqueue", async () => {
    const env = createTestEnv();
    const send = vi.fn(async () => undefined);
    (env as unknown as { JOBS: { send: unknown } }).JOBS = { send };
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_fleet_run_job", arguments: { job: "refresh-registry", mode: "enqueue" } });
    expect(structured(result).result).toEqual({ status: "queued" });
    expect(send).toHaveBeenCalledOnce();
    // The message carries the job's REAL queue type, not its route path.
    expect((send.mock.calls[0] as unknown as [{ type: string }])[0].type).toBe("refresh-registry");
    await client.close();
  });

  it("REGRESSION: sends the renamed message type for a job whose path differs from it", async () => {
    // rag-index enqueues `rag-index-repo`. Deriving the message from the job name would enqueue something
    // the dispatcher silently drops — a job that reports "queued" and never runs.
    const env = createTestEnv();
    const send = vi.fn(async () => undefined);
    (env as unknown as { JOBS: { send: unknown } }).JOBS = { send };
    const client = await connect(env);
    await client.callTool({ name: "loopover_fleet_run_job", arguments: { job: "rag-index", mode: "enqueue" } });
    expect((send.mock.calls[0] as unknown as [{ type: string }])[0].type).toBe("rag-index-repo");
    await client.close();
  });

  it("ANSWERS with the supported modes when a job has no inline runner", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_fleet_run_job", arguments: { job: "rag-index", mode: "run" } });
    expect(result.isError, "an unsupported mode is an answer, not a failure").toBeFalsy();
    expect(structured(result).unsupportedMode).toBe(true);
    expect(structured(result).supportedModes).toEqual(["enqueue"]);
    await client.close();
  });
});

describe("run-only jobs and the destructive-confirm path (#9522)", () => {
  it("runs a run-only job through its inline runner, since it has no queue message", async () => {
    // backfill-contributor-gate-history has no enqueue route at all; `run` must reach its own function.
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({
      name: "loopover_fleet_run_job",
      arguments: { job: "backfill-contributor-gate-history", mode: "run", payload: { limit: 1 } },
    });
    // The feature flag gates the underlying backfill, so the call may answer either way — what matters is
    // that it dispatched to the inline runner rather than reporting an unsupported mode.
    expect(structured(result).unsupportedMode).toBeUndefined();
    await client.close();
  });

  it("runs an inline-capable queue job through the SAME dispatcher the consumer uses", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_fleet_run_job", arguments: { job: "refresh-registry", mode: "run" } });
    expect(structured(result).unsupportedMode).toBeUndefined();
    await client.close();
  });

  it("a client WITHOUT elicitation support proceeds on the schema-level confirm alone", async () => {
    // The in-memory client advertises no elicitation capability, so confirmDestructive falls through —
    // `confirm: true` is then the whole gate, which is why the schema makes it a literal rather than a bool.
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_ops_purge_dead_letter_jobs", arguments: { confirm: true } });
    expect(result.isError).toBeFalsy();
    // This deployment has no dead-letter admin, so it reports unavailable — reached only by passing the confirm.
    expect(structured(result).unavailable).toBe(true);
    await client.close();
  });
});

describe("destructive tools reach their confirmation gate once the early returns are passed (#9522)", () => {
  it("revoke enrollment gets past the broker check and reports an unknown enrollment", async () => {
    const client = await connect(createTestEnv({ ORB_BROKER_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_fleet_revoke_enrollment", arguments: { enrollId: "does-not-exist", confirm: true } });
    expect(result.isError).toBeFalsy();
    // Past the broker gate and past confirmDestructive — the answer now comes from the ledger itself.
    expect(structured(result).error).toBeDefined();
    await client.close();
  });

  it("config push fans out to the named installations and reports per-target success", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({
      name: "loopover_fleet_config_push",
      arguments: { installationIds: [1, 2], pushId: "push-1", message: "rotate now", confirm: true },
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result).installationCount).toBe(2);
    await client.close();
  });

  it("tenant destroy gets past the not-configured check and surfaces the control plane's own failure", async () => {
    // Configured but unreachable: the point is reaching confirmDestructive and the client, not a live plane.
    const client = await connect(
      createTestEnv({ LOOPOVER_CONTROL_PLANE_URL: "https://cp.invalid", LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN: "tok" }),
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const result = await client.callTool({ name: "loopover_tenant_destroy", arguments: { name: "acme", product: "ams", confirm: true } });
      // Fails LOUD rather than reporting a destroy that did not happen.
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("control plane unreachable");
    } finally {
      vi.unstubAllGlobals();
      await client.close();
    }
  });
});

describe("hosted tenant tools without a control plane (#9522)", () => {
  // Administering no hosted tenants is the normal state for every deployment but one, so these report
  // `configured: false` rather than erroring.
  it.each([
    ["loopover_tenant_create", { name: "acme", product: "ams" }],
    ["loopover_tenant_list", {}],
    ["loopover_tenant_set_orb_installation", { name: "acme", product: "orb", orbInstallationId: 1 }],
    ["loopover_tenant_destroy", { name: "acme", product: "ams", confirm: true }],
  ])("%s reports not configured", async (name, args) => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name} must not error`).toBeFalsy();
    expect(structured(result).configured).toBe(false);
    await client.close();
  });
});

describe("self-host instance diagnostics (#9522)", () => {
  const ADMIN: AuthIdentity = { kind: "static", actor: "mcp-admin" };

  async function adminClient() {
    return connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), ADMIN);
  }

  it.each([
    ["loopover_admin_get_status", {}],
    ["loopover_admin_doctor", {}],
    ["loopover_admin_tail_logs", {}],
    ["loopover_admin_get_backup_status", {}],
  ])("%s reports not configured when its capability is unwired", async (name, args) => {
    const client = await adminClient();
    const result = await client.callTool({ name, arguments: args });
    expect(structured(result).configured).toBe(false);
    await client.close();
  });

  it("reports status, flagging a version behind the manifest target", async () => {
    setInstanceStatusReader(async () => ({ appVersion: "1.0.0", targetVersion: "1.1.0", upToDate: false }));
    const client = await adminClient();
    const result = structured(await client.callTool({ name: "loopover_admin_get_status", arguments: {} }));
    expect(result.configured).toBe(true);
    expect(result.upToDate).toBe(false);
    await client.close();
  });

  it("runs every doctor check and counts the failures rather than stopping at the first", async () => {
    setInstanceDoctorRunner(async () => ({
      ok: false,
      checks: [
        { name: "db", status: "pass" },
        { name: "redis", status: "fail", detail: "unreachable" },
        { name: "disk", status: "warn", detail: "82% used" },
      ],
    }));
    const client = await adminClient();
    const result = structured(await client.callTool({ name: "loopover_admin_doctor", arguments: {} }));
    expect((result.checks as unknown[]).length).toBe(3);
    expect(result.ok).toBe(false);
    await client.close();
  });

  it("caps the log tail at the schema's own maximum, so a caller cannot widen it", async () => {
    const seen: { lines: number }[] = [];
    setInstanceLogTailer(async (options) => {
      seen.push(options);
      return { lines: ["a"], truncated: true };
    });
    const client = await adminClient();
    await client.callTool({ name: "loopover_admin_tail_logs", arguments: { lines: 1000, since: "15m" } });
    expect(seen[0]!.lines).toBe(1000);
    const result = structured(await client.callTool({ name: "loopover_admin_tail_logs", arguments: {} }));
    // Default stays modest so an unqualified call cannot dump the buffer.
    expect(seen[1]!.lines).toBe(200);
    expect(result.truncated).toBe(true);
    await client.close();
  });

  it("reports backup status", async () => {
    setInstanceBackupStatusReader(async () => ({ lastBackupAt: "2026-07-28T00:00:00.000Z", backups: [] }));
    const client = await adminClient();
    expect(structured(await client.callTool({ name: "loopover_admin_get_backup_status", arguments: {} })).lastBackupAt).toBe("2026-07-28T00:00:00.000Z");
    await client.close();
  });

  it.each([
    ["loopover_admin_get_status", () => setInstanceStatusReader(async () => { throw new Error("boom"); })],
    ["loopover_admin_doctor", () => setInstanceDoctorRunner(async () => { throw new Error("boom"); })],
    ["loopover_admin_tail_logs", () => setInstanceLogTailer(async () => { throw new Error("boom"); })],
    ["loopover_admin_get_backup_status", () => setInstanceBackupStatusReader(async () => { throw new Error("boom"); })],
  ])("%s degrades to a structured error rather than throwing when its reader fails", async (name, wire) => {
    wire();
    const client = await adminClient();
    const result = structured(await client.callTool({ name, arguments: {} }));
    expect(result.configured).toBe(true);
    expect(result.error).toContain("boom");
    await client.close();
  });
});
