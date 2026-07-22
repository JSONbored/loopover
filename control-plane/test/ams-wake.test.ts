// Tests for the AMS cron-wake orchestration (#7182). No live Cloudflare Containers/KV anywhere here --
// WakeNamespaceLike/WakeStubLike are hand-rolled fakes, mirroring container-driver.test.ts's own convention.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeTenantRegistry,
  wakeDueAmsTenants,
  type AmsWakeConfig,
  type TenantRegistry,
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
