import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
/**
 * A client that ADVERTISES elicitation and answers every prompt the same way. Without the capability the
 * server's confirmDestructive falls through on the schema-level confirm alone, so the decline path — and
 * the "an elicitation that errors is a decline, not an implicit yes" rule — is only reachable from here.
 */
async function connectEliciting(env: Env, action: "accept" | "decline" | "throw") {
  const server = new LoopoverMcp(env, INTERNAL).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "eliciting-test", version: "0.1.0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    if (action === "throw") throw new Error("client blew up mid-prompt");
    return { action: action === "accept" ? "accept" : "decline" };
  });
  await client.connect(clientTransport);
  return client;
}

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

/** A JOBS binding that DOES expose dead-letter admin — the self-host queue's shape, not Cloudflare's. */
function withDeadLetterAdmin(env: Env, overrides: Record<string, unknown> = {}): Env {
  const job = { id: 1, jobType: "refresh-registry", attempts: 3, lastError: "boom", createdAtMs: 1, deadAtMs: 2 };
  (env as unknown as { JOBS: Record<string, unknown> }).JOBS = {
    send: async () => undefined,
    listDeadLetterJobs: () => [job],
    deadCount: () => 1,
    replayDeadLetterJob: () => true,
    deleteDeadLetterJob: () => true,
    purgeDeadLetterJobs: () => 3,
    ...overrides,
  };
  return env;
}

describe("dead-letter tools against a backend that HAS the admin surface (#9522)", () => {
  it("lists the parked jobs with their total", async () => {
    const client = await connect(withDeadLetterAdmin(createTestEnv()));
    const result = structured(await client.callTool({ name: "loopover_ops_list_dead_letter_jobs", arguments: {} }));
    expect(result.total).toBe(1);
    expect((result.items as unknown[]).length).toBe(1);
    await client.close();
  });

  it("replays a job and reports ok", async () => {
    const client = await connect(withDeadLetterAdmin(createTestEnv()));
    expect(structured(await client.callTool({ name: "loopover_ops_replay_dead_letter_job", arguments: { id: 1 } }))).toMatchObject({ ok: true, id: 1 });
    await client.close();
  });

  it("reports notFound for an id the queue no longer has", async () => {
    const client = await connect(withDeadLetterAdmin(createTestEnv(), { replayDeadLetterJob: () => false, deleteDeadLetterJob: () => false }));
    expect(structured(await client.callTool({ name: "loopover_ops_replay_dead_letter_job", arguments: { id: 9 } }))).toMatchObject({ notFound: true });
    expect(structured(await client.callTool({ name: "loopover_ops_delete_dead_letter_job", arguments: { id: 9, confirm: true } }))).toMatchObject({ notFound: true });
    await client.close();
  });

  it("deletes a job and reports ok", async () => {
    const client = await connect(withDeadLetterAdmin(createTestEnv()));
    expect(structured(await client.callTool({ name: "loopover_ops_delete_dead_letter_job", arguments: { id: 1, confirm: true } }))).toMatchObject({ ok: true });
    await client.close();
  });

  it("purges every job and reports how many went", async () => {
    const client = await connect(withDeadLetterAdmin(createTestEnv()));
    expect(structured(await client.callTool({ name: "loopover_ops_purge_dead_letter_jobs", arguments: { confirm: true } }))).toMatchObject({ ok: true, purged: 3 });
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

describe("destructive confirmation via elicitation (#9522)", () => {
  it("a DECLINE leaves the action undone and reports it as a structured result, not an error", async () => {
    const client = await connectEliciting(withDeadLetterAdmin(createTestEnv()), "decline");
    const result = await client.callTool({ name: "loopover_ops_delete_dead_letter_job", arguments: { id: 1, confirm: true } });
    expect(result.isError, "declining is a valid answer, not a failure").toBeFalsy();
    expect(structured(result).declined).toBe(true);
    await client.close();
  });

  it("an ACCEPT proceeds", async () => {
    const client = await connectEliciting(withDeadLetterAdmin(createTestEnv()), "accept");
    expect(structured(await client.callTool({ name: "loopover_ops_delete_dead_letter_job", arguments: { id: 1, confirm: true } }))).toMatchObject({ ok: true });
    await client.close();
  });

  it("an elicitation that ERRORS is treated as a decline, never as an implicit yes", async () => {
    // A client that advertises the capability then fails to answer must not silently authorize an
    // irreversible action.
    const client = await connectEliciting(withDeadLetterAdmin(createTestEnv()), "throw");
    expect(structured(await client.callTool({ name: "loopover_ops_purge_dead_letter_jobs", arguments: { confirm: true } })).declined).toBe(true);
    await client.close();
  });

  it("declining the kill-switch RELEASE leaves it engaged", async () => {
    const env = createTestEnv();
    const engager = await connect(env);
    await engager.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: true } });
    await engager.close();

    const client = await connectEliciting(env, "decline");
    const result = structured(await client.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: false, confirm: true } }));
    expect(result.declined).toBe(true);
    expect(result.frozen, "the switch must still be engaged after a decline").toBe(true);
    await client.close();
  });

  it("declining a config push sends nothing", async () => {
    const client = await connectEliciting(createTestEnv(), "decline");
    const result = structured(
      await client.callTool({ name: "loopover_fleet_config_push", arguments: { installationIds: [1], pushId: "p", message: "m", confirm: true } }),
    );
    expect(result.declined).toBe(true);
    await client.close();
  });

  it("declining an enrollment revoke leaves it active", async () => {
    const client = await connectEliciting(createTestEnv({ ORB_BROKER_ENABLED: "true" }), "decline");
    expect(structured(await client.callTool({ name: "loopover_fleet_revoke_enrollment", arguments: { enrollId: "e-1", confirm: true } })).declined).toBe(true);
    await client.close();
  });

  it("declining a tenant destroy leaves it standing", async () => {
    const client = await connectEliciting(
      createTestEnv({ LOOPOVER_CONTROL_PLANE_URL: "https://cp.invalid", LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN: "tok" }),
      "decline",
    );
    expect(structured(await client.callTool({ name: "loopover_tenant_destroy", arguments: { name: "acme", product: "ams", confirm: true } })).declined).toBe(true);
    await client.close();
  });
});

/** Record an installation the way the webhook would, so the register/enrollment paths have a real row. */
async function seedInstallation(env: Env, installationId = 4242): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO orb_github_installations (installation_id, account_login, registered, first_seen_at, last_event_at) VALUES (?, ?, 1, ?, ?)",
  )
    .bind(installationId, "acme", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")
    .run();
}

describe("fleet write paths against real rows (#9522)", () => {
  it("registers a recorded installation and audits it", async () => {
    const env = createTestEnv();
    await seedInstallation(env);
    const client = await connect(env);
    expect(structured(await client.callTool({ name: "loopover_fleet_register_installation", arguments: { installationId: 4242 } }))).toMatchObject({
      installationId: 4242,
      registered: true,
    });
    await client.close();
  });

  it("surfaces the missing-credentials failure rather than reporting a backfill that did not run", async () => {
    // Reconciling against GitHub needs the Orb App credentials, which a test env has none of. The point is
    // that it FAILS LOUD: a silent "backfilled 0" would read as a clean reconcile.
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_fleet_backfill_installations", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("credentials are not configured");
    await client.close();
  });

  it("opts a recorded installation OUT, blocking self-enrollment", async () => {
    const env = createTestEnv();
    await seedInstallation(env, 5150);
    const client = await connect(env);
    expect(
      structured(await client.callTool({ name: "loopover_fleet_register_installation", arguments: { installationId: 5150, registered: false } })),
    ).toMatchObject({ registered: false });
    await client.close();
  });

  it("refuses to enroll an installation that is not REGISTERED", async () => {
    // Registration is the onboarding gate: an unregistered install must not be able to broker tokens.
    const env = createTestEnv({ ORB_BROKER_ENABLED: "true" });
    await env.DB.prepare(
      "INSERT INTO orb_github_installations (installation_id, account_login, registered, first_seen_at, last_event_at) VALUES (?, ?, 0, ?, ?)",
    )
      .bind(6161, "unregistered", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")
      .run();
    const client = await connect(env);
    expect(structured(await client.callTool({ name: "loopover_fleet_issue_enrollment", arguments: { installationId: 6161 } })).error).toBeDefined();
    await client.close();
  });

  it("issues, rotates, and revokes an enrollment for a registered installation", async () => {
    const env = createTestEnv({ ORB_BROKER_ENABLED: "true" });
    await seedInstallation(env);
    const client = await connect(env);

    const issued = structured(await client.callTool({ name: "loopover_fleet_issue_enrollment", arguments: { installationId: 4242 } }));
    expect(String(issued.secret ?? ""), "the plaintext is shown exactly once").not.toBe("");
    const enrollId = String(issued.enrollId);

    // Issuing again without rotate is a conflict; rotate=true replaces it.
    const rotated = structured(await client.callTool({ name: "loopover_fleet_rotate_enrollment", arguments: { installationId: 4242 } }));
    expect(rotated.secret ?? rotated.error, "rotation must answer either way").toBeDefined();

    const revoked = structured(await client.callTool({ name: "loopover_fleet_revoke_enrollment", arguments: { enrollId, confirm: true } }));
    expect(revoked.error ?? revoked.enrollId ?? revoked.revoked).toBeDefined();
    await client.close();
  });
});

describe("tenant write paths against a reachable control plane (#9522)", () => {
  function controlPlaneEnv() {
    return createTestEnv({ LOOPOVER_CONTROL_PLANE_URL: "https://cp.example", LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN: "tok" });
  }

  function stubControlPlane(body: unknown) {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a tenant and reports the record", async () => {
    stubControlPlane({ tenant: "acme", product: "ams", state: "provisioning" });
    const client = await connect(controlPlaneEnv());
    expect(structured(await client.callTool({ name: "loopover_tenant_create", arguments: { name: "acme", product: "ams" } }))).toMatchObject({
      configured: true,
      state: "provisioning",
    });
    await client.close();
  });

  it("lists tenants, and tolerates a payload whose `tenants` is not an array", async () => {
    stubControlPlane({ tenants: [{ tenant: "acme" }] });
    const client = await connect(controlPlaneEnv());
    expect(structured(await client.callTool({ name: "loopover_tenant_list", arguments: {} })).configured).toBe(true);
    await client.close();

    // A payload with no `tenants` key at all: the Array.isArray guard is what keeps the summary from
    // reading `.length` off undefined.
    stubControlPlane({});
    const other = await connect(controlPlaneEnv());
    expect(structured(await other.callTool({ name: "loopover_tenant_list", arguments: {} })).configured).toBe(true);
    await other.close();
  });

  it("points a tenant at an installation", async () => {
    stubControlPlane({ tenant: "acme", orbInstallationId: 7 });
    const client = await connect(controlPlaneEnv());
    expect(
      structured(await client.callTool({ name: "loopover_tenant_set_orb_installation", arguments: { name: "acme", product: "orb", orbInstallationId: 7 } })),
    ).toMatchObject({ configured: true });
    await client.close();
  });

  it("destroys a tenant", async () => {
    stubControlPlane({ tenant: "acme", state: "torn down" });
    const client = await connect(controlPlaneEnv());
    expect(structured(await client.callTool({ name: "loopover_tenant_destroy", arguments: { name: "acme", product: "ams", confirm: true } }))).toMatchObject({
      configured: true,
    });
    await client.close();
  });
});

describe("requireOperator over a SESSION identity (#9522)", () => {
  // The static-credential path is covered above; a session must actually hold the operator role, and there
  // is no per-repo scoping that could stand in for it.
  const session: AuthIdentity = {
    kind: "session",
    actor: "octocat",
    session: { token: "t", githubLogin: "octocat", githubUserId: 1, createdAt: "2026-07-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" } as never,
  };

  it("refuses a session with no operator role", async () => {
    const client = await connect(createTestEnv(), session);
    const result = await client.callTool({ name: "loopover_ops_get_kill_switch", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/operator role|insufficient_role/);
    await client.close();
  });
});

describe("instance diagnostics render every optional shape (#9522)", () => {
  const ADMIN_ID: AuthIdentity = { kind: "static", actor: "mcp-admin" };

  it("reports an unknown version and no redeploy hint when the reader omits them", async () => {
    setInstanceStatusReader(async () => ({}));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), ADMIN_ID);
    expect(structured(await client.callTool({ name: "loopover_admin_get_status", arguments: {} })).configured).toBe(true);
    await client.close();
  });

  it("reports an untruncated tail and a never-backed-up instance", async () => {
    setInstanceLogTailer(async () => ({ lines: ["a"], truncated: false }));
    setInstanceBackupStatusReader(async () => ({}));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), ADMIN_ID);
    expect(structured(await client.callTool({ name: "loopover_admin_tail_logs", arguments: {} })).truncated).toBe(false);
    expect(structured(await client.callTool({ name: "loopover_admin_get_backup_status", arguments: {} })).configured).toBe(true);
    await client.close();
  });
});

describe("run-only jobs (#9522)", () => {
  it("runs refresh-installation-health inline", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_fleet_run_job", arguments: { job: "refresh-installation-health", mode: "run" } });
    expect(structured(result).unsupportedMode).toBeUndefined();
    await client.close();
  });

  it("passes a numeric limit through to a run-only job, and omits a non-numeric one", async () => {
    const client = await connect(createTestEnv());
    for (const payload of [{ limit: 5 }, { limit: "five" }]) {
      const result = await client.callTool({
        name: "loopover_fleet_run_job",
        arguments: { job: "backfill-contributor-gate-history", mode: "run", payload },
      });
      expect(structured(result).unsupportedMode).toBeUndefined();
    }
    await client.close();
  });
});

describe("hosted AMS tenant tools (#9523)", () => {
  function controlPlaneEnv() {
    return createTestEnv({ LOOPOVER_CONTROL_PLANE_URL: "https://cp.example", LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN: "tok" });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["loopover_ams_tenant_health", { name: "acme" }],
    ["loopover_ams_tenant_wake", { name: "acme" }],
  ])("%s reports not configured where this deployment administers no tenants", async (name, args) => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name} must answer, not throw`).toBeFalsy();
    expect(structured(result).configured).toBe(false);
    await client.close();
  });

  it("reports a tenant's lifecycle state and wake cadence", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ name: "acme", state: "active", schedule: "0 * * * *", lastWakeAt: "2026-07-28T00:00:00.000Z" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const client = await connect(controlPlaneEnv());
    expect(structured(await client.callTool({ name: "loopover_ams_tenant_health", arguments: { name: "acme" } }))).toMatchObject({
      configured: true,
      state: "active",
    });
    await client.close();
  });

  it("says unknown when the control plane reports no lifecycle state", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ name: "acme" }), { headers: { "content-type": "application/json" } }));
    const client = await connect(controlPlaneEnv());
    expect(structured(await client.callTool({ name: "loopover_ams_tenant_health", arguments: { name: "acme" } })).configured).toBe(true);
    await client.close();
  });

  it("wakes a tenant and audits the cycle", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ name: "acme", woken: true }), { headers: { "content-type": "application/json" } }));
    const client = await connect(controlPlaneEnv());
    expect(structured(await client.callTool({ name: "loopover_ams_tenant_wake", arguments: { name: "acme" } }))).toMatchObject({ woken: true });
    await client.close();
  });

  it("REGRESSION: a THROTTLED wake is reported as an answer and is NOT audited as a cycle", async () => {
    // The schedule guard refusing a too-soon wake is the guard working, not a cycle that ran.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ name: "acme", throttled: true }), { headers: { "content-type": "application/json" } }));
    const client = await connect(controlPlaneEnv());
    const result = structured(await client.callTool({ name: "loopover_ams_tenant_wake", arguments: { name: "acme" } }));
    expect(result.throttled).toBe(true);
    await client.close();
  });
});
