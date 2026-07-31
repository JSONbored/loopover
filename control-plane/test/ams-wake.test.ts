// Tests for the AMS cron-wake orchestration (#7182). No live Cloudflare Containers/KV anywhere here --
// WakeNamespaceLike/WakeStubLike are hand-rolled fakes, mirroring container-driver.test.ts's own convention.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeTenantRegistry,
  wakeDueAmsTenants,
  type AmsWakeConfig,
  type TenantRegistry,
  type TenantRegistryRecord,
  type WakeNamespaceLike,
  type WakeStubLike,
} from "../dist/index.js";

type FakeWakeStub = WakeStubLike & { starts: Array<{ entrypoint?: string[] }>; getStateCalls: number };

function fakeWakeStub(states: Array<{ status: string; exitCode?: number }>): FakeWakeStub {
  const starts: Array<{ entrypoint?: string[] }> = [];
  let index = 0;
  return {
    starts,
    get getStateCalls() {
      return index;
    },
    async start(options) {
      starts.push(options ?? {});
    },
    async getState() {
      const state = states[Math.min(index, states.length - 1)]!;
      index += 1;
      return state;
    },
  };
}

function fakeNamespace(stubs: Record<string, FakeWakeStub>): WakeNamespaceLike & { requestedNames: string[] } {
  const requestedNames: string[] = [];
  return {
    requestedNames,
    getByName(name: string) {
      requestedNames.push(name);
      const stub = stubs[name];
      if (!stub) throw new Error(`fakeNamespace: no stub registered for "${name}"`);
      return stub;
    },
  };
}

// A stub whose start() (or getState(), depending on which array holds a rejecting entry) throws instead of
// resolving -- used to simulate #10063's unreachable-container failure modes. `starts`/`getStateCalls` are
// tracked the same way fakeWakeStub's are, so assertions on call counts/entrypoints still work.
function throwingStartStub(): FakeWakeStub {
  const starts: Array<{ entrypoint?: string[] }> = [];
  return {
    starts,
    getStateCalls: 0,
    async start(options) {
      starts.push(options ?? {});
      throw new Error("container failed to start");
    },
    async getState() {
      throw new Error("should not be called: start() already rejected");
    },
  };
}

function throwingGetStateStub(): FakeWakeStub {
  const starts: Array<{ entrypoint?: string[] }> = [];
  let getStateCalls = 0;
  return {
    starts,
    get getStateCalls() {
      return getStateCalls;
    },
    async start(options) {
      starts.push(options ?? {});
    },
    async getState() {
      getStateCalls += 1;
      throw new Error("container health check failed");
    },
  };
}

// Wraps a registry so `upsert()` rejects for any record matching `shouldFail` -- PERSISTENTLY (every
// matching call, not just the first), so a test can exercise both the outer per-tenant catch and its own
// inner catch (the "the failure write itself also failed" branch) in one go, rather than having the retry
// inside the catch quietly succeed.
function withFailingUpsert(base: TenantRegistry, shouldFail: (record: TenantRegistryRecord) => boolean): TenantRegistry {
  return {
    ...base,
    async upsert(record) {
      if (shouldFail(record)) throw new Error("registry upsert rejected");
      await base.upsert(record);
    },
  };
}

function baseConfig(overrides: Partial<AmsWakeConfig> & { binding: WakeNamespaceLike; registry: TenantRegistry }): AmsWakeConfig {
  return { pollIntervalMs: 1, pollTimeoutMs: 50, ...overrides };
}

const NOW = new Date("2026-01-01T00:00:00.000Z");
const PAST = new Date("2025-12-31T23:00:00.000Z").toISOString();
const FUTURE = new Date("2026-01-01T01:00:00.000Z").toISOString();

test("wakeDueAmsTenants: nothing due at all returns an empty result and touches no container", async () => {
  const registry = createFakeTenantRegistry();
  const namespace = fakeNamespace({});

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.deepEqual(results, []);
  assert.deepEqual(namespace.requestedNames, []);
});

test("wakeDueAmsTenants: skips a non-AMS (orb) tenant even with a schedule and a past nextDueAt", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "orb",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const namespace = fakeNamespace({});

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.deepEqual(results, []);
});

test("wakeDueAmsTenants: skips an AMS tenant with no schedule at all", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "ams", state: "active", createdAt: "t0", updatedAt: "t0" });
  const namespace = fakeNamespace({});

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.deepEqual(results, []);
});

test("wakeDueAmsTenants: skips a torn-down AMS tenant even with a due schedule", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "torn down",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const namespace = fakeNamespace({});

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.deepEqual(results, []);
});

test("wakeDueAmsTenants: skips an AMS tenant whose schedule isn't due yet", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: FUTURE },
  });
  const namespace = fakeNamespace({});

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.deepEqual(results, []);
});

test("wakeDueAmsTenants: wakes a due tenant with the right entrypoint, records the real exit code, and advances nextDueAt from the tick start", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: ["--search", "label:good-first-issue"], intervalMs: 60_000, nextDueAt: PAST },
  });
  const stub = fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]);
  const namespace = fakeNamespace({ "ams:acme": stub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(namespace.requestedNames[0], "ams:acme");
  assert.deepEqual(stub.starts, [{ entrypoint: ["loopover-miner-hosted", "discover", "--search", "label:good-first-issue"] }]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.exitCode, 0);
  assert.equal(results[0]!.timedOut, false);

  const record = await registry.get("acme", "ams");
  assert.equal(record?.amsSchedule?.lastExitCode, 0);
  assert.equal(record?.amsSchedule?.nextDueAt, new Date(NOW.getTime() + 60_000).toISOString());
  assert.equal(record?.amsSchedule?.lastRunAt, results[0]!.ranAt);
  assert.equal(record?.updatedAt, results[0]!.ranAt);
});

test("wakeDueAmsTenants: records the real failure exit code (2) unmodified", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "manage-poll", args: ["acme/widgets", "42"], intervalMs: 60_000, nextDueAt: PAST },
  });
  const stub = fakeWakeStub([{ status: "stopped_with_code", exitCode: 2 }]);
  const namespace = fakeNamespace({ "ams:acme": stub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(results[0]!.exitCode, 2);
  assert.equal(results[0]!.timedOut, false);
});

test("wakeDueAmsTenants: polls through multiple non-stopped states before the container finishes", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const stub = fakeWakeStub([{ status: "running" }, { status: "healthy" }, { status: "stopped_with_code", exitCode: 0 }]);
  const namespace = fakeNamespace({ "ams:acme": stub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(stub.getStateCalls, 3);
  assert.equal(results[0]!.exitCode, 0);
});

test("wakeDueAmsTenants: a bare 'stopped' status (no exit code) is treated as finished, not a timeout", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const stub = fakeWakeStub([{ status: "stopped" }]);
  const namespace = fakeNamespace({ "ams:acme": stub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(results[0]!.exitCode, undefined);
  assert.equal(results[0]!.timedOut, false);
});

test("wakeDueAmsTenants: a container that never stops within the poll timeout is reported as timed out", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const stub = fakeWakeStub(Array.from({ length: 200 }, () => ({ status: "running" })));
  const namespace = fakeNamespace({ "ams:acme": stub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW, pollIntervalMs: 1, pollTimeoutMs: 20 }));

  assert.equal(results[0]!.exitCode, undefined);
  assert.equal(results[0]!.timedOut, true);
  // The schedule still advances even on a timeout -- a hung wake must not block every future tick forever.
  const record = await registry.get("acme", "ams");
  assert.equal(record?.amsSchedule?.nextDueAt, new Date(NOW.getTime() + 60_000).toISOString());
});

test("wakeDueAmsTenants: wakes multiple due tenants sequentially, not concurrently", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  await registry.upsert({
    tenant: { name: "beta" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "attempt", args: ["item-1"], intervalMs: 30_000, nextDueAt: PAST },
  });
  const order: string[] = [];
  const acmeStub: FakeWakeStub = { ...fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]), start: async () => void order.push("acme-start") };
  const betaStub: FakeWakeStub = { ...fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]), start: async () => void order.push("beta-start") };
  const namespace = fakeNamespace({ "ams:acme": acmeStub, "ams:beta": betaStub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(results.length, 2);
  assert.deepEqual(order, ["acme-start", "beta-start"]);
});

// #9143 (defect 7): the load-bearing overlap-guard regression test. Before this fix, nextDueAt only advanced
// AFTER a woken tenant's poll resolved -- a genuinely-overlapping tick (the 5-minute cron firing again while a
// slow/hung poll from the PRIOR tick was still running) would see the SAME tenant still due and wake it a
// second time concurrently, with no lock or in-flight marker anywhere to stop it. nextDueAt is now claimed
// BEFORE the poll starts, so an overlapping tick observes the claim and skips the tenant entirely.
test("wakeDueAmsTenants: an overlapping tick does not re-wake a tenant whose poll from the PRIOR tick hasn't resolved yet (#9143)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    // A 1-hour cadence: long enough that tick 2 (5 minutes after tick 1, per wrangler.jsonc's `*/5 * * * *`)
    // is NOT yet due again on its own merits -- the only way tick 2 could still see "acme" as due is the
    // PRE-#9143 bug (nextDueAt never advanced until the poll resolved), not a legitimately-elapsed interval.
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60 * 60_000, nextDueAt: PAST },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let getStateCallCount = 0;
  const stub: FakeWakeStub = {
    starts: [],
    getStateCalls: 0,
    async start() {},
    async getState() {
      getStateCallCount += 1;
      await gate; // simulates a hung/slow container: the PRIOR tick's poll is still in flight
      return { status: "stopped_with_code", exitCode: 0 };
    },
  };
  const namespace = fakeNamespace({ "ams:acme": stub });

  // Tick 1 (the current cron invocation) starts waking "acme" and gets stuck mid-poll.
  const tick1 = wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));
  await new Promise((resolve) => setImmediate(resolve));

  try {
    // Tick 2 (the SAME cron firing again 5 minutes later) must NOT see "acme" as due anymore -- its
    // nextDueAt was already claimed forward by tick 1, before tick 1's poll ever started, not after it
    // resolves.
    const tick2 = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => new Date(NOW.getTime() + 5 * 60_000) }));

    assert.deepEqual(tick2, []);
    assert.equal(getStateCallCount, 1); // tick 2 never touched this tenant's container at all
  } finally {
    // Always unblock tick 1 and let it finish, even if an assertion above threw -- otherwise its promise
    // dangles past the end of this test and the runner cancels every later test in the file.
    release();
    await tick1;
  }
});

// #9143 (defect 7): bounds a single tick's total wall-clock exposure across MULTIPLE due tenants, not just
// one hung tenant -- a fleet with more due tenants than the cap in one 5-minute window defers the excess to
// the next tick instead.
test("wakeDueAmsTenants: maxTenantsPerTick bounds how many due tenants ONE tick wakes, deferring the rest to the next tick (#9143)", async () => {
  const registry = createFakeTenantRegistry();
  for (const name of ["acme", "beta", "gamma"]) {
    await registry.upsert({
      tenant: { name },
      product: "ams",
      state: "active",
      createdAt: "t0",
      updatedAt: "t0",
      amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
    });
  }
  const namespace = fakeNamespace({
    "ams:acme": fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]),
    "ams:beta": fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]),
    "ams:gamma": fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]),
  });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW, maxTenantsPerTick: 2 }));

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.tenant.name), ["acme", "beta"]);
  // "gamma" was left completely untouched -- still due (nextDueAt unchanged), ready for the next tick.
  const gamma = await registry.get("gamma", "ams");
  assert.equal(gamma?.amsSchedule?.nextDueAt, PAST);
  assert.deepEqual(namespace.requestedNames, ["ams:acme", "ams:beta"]);
});

test("wakeDueAmsTenants: defaults now/pollIntervalMs/pollTimeoutMs when not given", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: new Date(Date.now() - 1000).toISOString() },
  });
  const stub = fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]);
  const namespace = fakeNamespace({ "ams:acme": stub });

  const results = await wakeDueAmsTenants({ binding: namespace, registry });

  assert.equal(results.length, 1);
});

// #10063: one tenant's wake failing must not abort the tick for every OTHER due tenant, and the failed
// tenant must still show up in the result array (flagged, not silently dropped) rather than being
// indistinguishable from a tenant that never ran.
test("wakeDueAmsTenants: the FIRST due tenant's start() rejecting still lets the second one wake", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  await registry.upsert({
    tenant: { name: "beta" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "attempt", args: ["item-1"], intervalMs: 30_000, nextDueAt: PAST },
  });
  const betaStub = fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]);
  const namespace = fakeNamespace({ "ams:acme": throwingStartStub(), "ams:beta": betaStub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(results.length, 2);
  assert.equal(results[0]!.tenant.name, "acme");
  assert.equal(results[0]!.failed, true);
  assert.equal(results[0]!.exitCode, undefined);
  assert.equal(results[0]!.timedOut, false);
  assert.equal(results[1]!.tenant.name, "beta");
  assert.equal(results[1]!.failed, false);
  assert.equal(results[1]!.exitCode, 0);
  assert.deepEqual(betaStub.starts, [{ entrypoint: ["loopover-miner-hosted", "attempt", "item-1"] }]);

  // The failed tenant's lastRunAt write was still attempted, so it doesn't look like it never ran.
  const acme = await registry.get("acme", "ams");
  assert.equal(acme?.amsSchedule?.lastRunAt, results[0]!.ranAt);
});

test("wakeDueAmsTenants: a getState() rejection mid-poll is flagged failed, not timedOut, and the next tenant still runs", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  await registry.upsert({
    tenant: { name: "beta" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const namespace = fakeNamespace({ "ams:acme": throwingGetStateStub(), "ams:beta": fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]) });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(results.length, 2);
  assert.equal(results[0]!.failed, true);
  assert.equal(results[0]!.timedOut, false);
  assert.equal(results[0]!.exitCode, undefined);
  assert.equal(results[1]!.tenant.name, "beta");
  assert.equal(results[1]!.exitCode, 0);
});

test("wakeDueAmsTenants: the post-run registry.upsert rejecting is caught, and the next tenant still runs", async () => {
  const baseRegistry = createFakeTenantRegistry();
  await baseRegistry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  await baseRegistry.upsert({
    tenant: { name: "beta" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  // Fails every upsert carrying a lastRunAt for "acme" -- both the happy-path post-run write AND the
  // catch's own retry of that same write, so this one test also exercises the catch's inner catch (the
  // retry-also-throws branch), not just the outer one.
  const registry = withFailingUpsert(baseRegistry, (record) => record.tenant.name === "acme" && record.amsSchedule?.lastRunAt !== undefined);
  const namespace = fakeNamespace({
    "ams:acme": fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]),
    "ams:beta": fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]),
  });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(results.length, 2);
  assert.equal(results[0]!.tenant.name, "acme");
  assert.equal(results[0]!.failed, true);
  assert.equal(results[1]!.tenant.name, "beta");
  assert.equal(results[1]!.failed, false);
  assert.equal(results[1]!.exitCode, 0);
  // "acme"'s claim (the FIRST upsert, which doesn't carry lastRunAt) landed fine -- only the write this
  // registry was rigged to fail on never took, so the record still shows no lastRunAt at all.
  const acme = await baseRegistry.get("acme", "ams");
  assert.equal(acme?.amsSchedule?.lastRunAt, undefined);
});

test("wakeDueAmsTenants: a failed tenant still counts toward maxTenantsPerTick", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "acme" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  await registry.upsert({
    tenant: { name: "beta" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const namespace = fakeNamespace({ "ams:acme": throwingStartStub(), "ams:beta": fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]) });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW, maxTenantsPerTick: 1 }));

  assert.equal(results.length, 1);
  assert.equal(results[0]!.tenant.name, "acme");
  assert.equal(results[0]!.failed, true);
  // "beta" was left completely untouched by the cap, exactly as a successful "acme" would have left it.
  assert.deepEqual(namespace.requestedNames, ["ams:acme"]);
  const beta = await registry.get("beta", "ams");
  assert.equal(beta?.amsSchedule?.nextDueAt, PAST);
});

// #10063 regression: a permanently-broken tenant sorted FIRST by name must not starve every other due
// tenant sorted after it, tick after tick -- before this fix, its thrown rejection aborted the whole
// `wakeDueAmsTenants` call, so a healthy tenant later in the (name-sorted) list never even got reached.
test("wakeDueAmsTenants: a permanently-failing tenant sorted first by name never blocks a healthy tenant sorted after it (#10063)", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({
    tenant: { name: "aaa-broken" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  await registry.upsert({
    tenant: { name: "zzz-healthy" },
    product: "ams",
    state: "active",
    createdAt: "t0",
    updatedAt: "t0",
    amsSchedule: { command: "discover", args: [], intervalMs: 60_000, nextDueAt: PAST },
  });
  const healthyStub = fakeWakeStub([{ status: "stopped_with_code", exitCode: 0 }]);
  const namespace = fakeNamespace({ "ams:aaa-broken": throwingStartStub(), "ams:zzz-healthy": healthyStub });

  const results = await wakeDueAmsTenants(baseConfig({ binding: namespace, registry, now: () => NOW }));

  assert.equal(results.length, 2);
  assert.equal(results[0]!.tenant.name, "aaa-broken");
  assert.equal(results[0]!.failed, true);
  assert.equal(results[1]!.tenant.name, "zzz-healthy");
  assert.equal(results[1]!.failed, false);
  assert.equal(results[1]!.exitCode, 0);
  assert.deepEqual(healthyStub.starts, [{ entrypoint: ["loopover-miner-hosted", "discover"] }]);
});
