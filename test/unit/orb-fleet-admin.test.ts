import { describe, expect, it } from "vitest";
import { listFleetInstallations, listFleetInstances, registerFleetInstallation, registerFleetInstance } from "../../src/orb/fleet-admin";
import { createTestEnv } from "../helpers/d1";

// #9522: these four moved out of src/api/routes.ts so the MCP fleet tools and the /v1/internal/orb/* routes
// run ONE implementation. The route-level tests exercise the instance half; this covers all four directly,
// including the installation half and the branches the routes' own happy paths never reach.

/**
 * A D1 stand-in whose `.all()` resolves WITHOUT a `results` array. D1's own type marks `results` optional,
 * so the `?? []` arms in both list functions are reachable in principle and unreachable through the real
 * in-memory D1, which always returns one. Left uncovered they are the classic branch-coverage hole.
 */
function envWithResultlessDb(): Env {
  return {
    DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({}), first: async () => null, run: async () => ({}) }), all: async () => ({}) }),
    },
  } as unknown as Env;
}

async function seedInstance(env: Env, instanceId: string, seenAt = "2026-07-01T00:00:00.000Z"): Promise<void> {
  await env.DB.prepare("INSERT INTO orb_instances (instance_id, registered, first_seen_at, last_seen_at) VALUES (?, 0, ?, ?)")
    .bind(instanceId, seenAt, seenAt)
    .run();
}

async function seedInstallation(env: Env, installationId: number, login = "acme"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO orb_github_installations (installation_id, account_login, registered, first_seen_at, last_event_at) VALUES (?, ?, 0, ?, ?)",
  )
    .bind(installationId, login, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")
    .run();
}

describe("listFleetInstances", () => {
  it("returns an empty roster rather than throwing when nothing has ingested", async () => {
    expect(await listFleetInstances(createTestEnv())).toEqual({ instances: [] });
  });

  it("maps the stored 0/1 registered column to a real boolean", async () => {
    const env = createTestEnv();
    await seedInstance(env, "inst-a");
    const { instances } = await listFleetInstances(env);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.registered).toBe(false);
    expect(instances[0]!.instanceId).toBe("inst-a");
  });

  it("degrades to an empty roster when the driver returns no results array at all", async () => {
    expect(await listFleetInstances(envWithResultlessDb())).toEqual({ instances: [] });
  });

  it("orders by last activity, newest first", async () => {
    const env = createTestEnv();
    await seedInstance(env, "older", "2026-06-01T00:00:00.000Z");
    await seedInstance(env, "newer", "2026-07-20T00:00:00.000Z");
    const { instances } = await listFleetInstances(env);
    expect(instances.map((instance) => instance.instanceId)).toEqual(["newer", "older"]);
  });
});

describe("registerFleetInstance", () => {
  it("upserts an instance that has never been recorded, and mints its ingest secret ONCE", async () => {
    const env = createTestEnv();
    const result = await registerFleetInstance(env, { instanceId: "fresh" });
    expect(result.registered).toBe(true);
    expect(result.instanceSecret, "registering must return the plaintext exactly once").toMatch(/^orbis_/);

    // Only the HASH is persisted — the plaintext must not be recoverable from the row.
    const row = await env.DB.prepare("SELECT ingest_secret_hash FROM orb_instances WHERE instance_id = ?").bind("fresh").first<{ ingest_secret_hash: string }>();
    expect(row?.ingest_secret_hash).toBeTruthy();
    expect(row?.ingest_secret_hash).not.toBe(result.instanceSecret);
  });

  it("ROTATES the secret on a repeat register — the previous value stops working", async () => {
    const env = createTestEnv();
    const first = await registerFleetInstance(env, { instanceId: "rotating" });
    const second = await registerFleetInstance(env, { instanceId: "rotating" });
    expect(second.instanceSecret).toBeTruthy();
    expect(second.instanceSecret).not.toBe(first.instanceSecret);
  });

  it("opting OUT mints no secret and clears the registration timestamp", async () => {
    const env = createTestEnv();
    await registerFleetInstance(env, { instanceId: "opt-out" });
    const result = await registerFleetInstance(env, { instanceId: "opt-out", registered: false });
    expect(result.registered).toBe(false);
    expect(result.instanceSecret).toBeUndefined();
    const row = await env.DB.prepare("SELECT registered, registered_at FROM orb_instances WHERE instance_id = ?").bind("opt-out").first<{ registered: number; registered_at: string | null }>();
    expect(row?.registered).toBe(0);
    expect(row?.registered_at).toBeNull();
  });

  it("opting out PRESERVES the existing hash, so opting back in does not orphan a live credential mid-flight", async () => {
    const env = createTestEnv();
    await registerFleetInstance(env, { instanceId: "keep-hash" });
    const before = await env.DB.prepare("SELECT ingest_secret_hash FROM orb_instances WHERE instance_id = ?").bind("keep-hash").first<{ ingest_secret_hash: string }>();
    await registerFleetInstance(env, { instanceId: "keep-hash", registered: false });
    const after = await env.DB.prepare("SELECT ingest_secret_hash FROM orb_instances WHERE instance_id = ?").bind("keep-hash").first<{ ingest_secret_hash: string }>();
    expect(after?.ingest_secret_hash).toBe(before?.ingest_secret_hash);
  });
});

describe("listFleetInstallations", () => {
  it("returns an empty list when the registry is empty", async () => {
    expect(await listFleetInstallations(createTestEnv())).toEqual({ installations: [] });
  });

  it("degrades to an empty list when the driver returns no results array at all", async () => {
    expect(await listFleetInstallations(envWithResultlessDb())).toEqual({ installations: [] });
  });

  it("maps registered to a boolean and reports each install's live enrollment count", async () => {
    const env = createTestEnv();
    await seedInstallation(env, 111);
    const { installations } = await listFleetInstallations(env);
    expect(installations).toHaveLength(1);
    expect(installations[0]!.registered).toBe(false);
    expect(installations[0]!.installationId).toBe(111);
    // No enrollments seeded, so the correlated subquery must report zero rather than null.
    expect(installations[0]!.liveEnrollmentCount).toBe(0);
  });
});

describe("registerFleetInstallation", () => {
  it("REFUSES an installation the webhook has never recorded, rather than conjuring the row", async () => {
    // Registering an install the App may not actually hold is the failure this guards.
    expect(await registerFleetInstallation(createTestEnv(), { installationId: 999 })).toEqual({ error: "installation_not_found" });
  });

  it("registers a recorded installation and clears its self-enrollment block", async () => {
    const env = createTestEnv();
    await seedInstallation(env, 222);
    expect(await registerFleetInstallation(env, { installationId: 222 })).toEqual({ installationId: 222, registered: true });
    const row = await env.DB.prepare("SELECT registered, self_enrollment_disabled FROM orb_github_installations WHERE installation_id = ?").bind(222).first<{ registered: number; self_enrollment_disabled: number }>();
    expect(row).toEqual({ registered: 1, self_enrollment_disabled: 0 });
  });

  it("opting out also BLOCKS OAuth self-enrollment until an operator opts back in", async () => {
    const env = createTestEnv();
    await seedInstallation(env, 333);
    expect(await registerFleetInstallation(env, { installationId: 333, registered: false })).toEqual({ installationId: 333, registered: false });
    const row = await env.DB.prepare("SELECT registered, self_enrollment_disabled FROM orb_github_installations WHERE installation_id = ?").bind(333).first<{ registered: number; self_enrollment_disabled: number }>();
    expect(row).toEqual({ registered: 0, self_enrollment_disabled: 1 });
  });
});
