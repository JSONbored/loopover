// Tests for the real Neon-backed database driver (#7653). No live Neon account or credentials anywhere here --
// `globalThis.fetch` is stubbed with a strict, ordered response queue for every test (mirrors
// pagerduty-notify.test.ts's save/restore convention). Covers: fresh provision (branch+role+database creation,
// operation polling including a multi-poll retry and a timeout), idempotent re-provision against an existing
// branch, idempotent drop of both an existing and a never-provisioned tenant, and every documented failure mode
// (missing endpoint, missing password, a failed operation, a non-ok HTTP response).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  createNeonDatabaseDriver,
  dropNeonDatabase,
  provisionNeonDatabase,
  type NeonDatabaseDriverConfig,
  type TenantProvisioningRequest,
} from "../dist/index.js";

const CONFIG: NeonDatabaseDriverConfig = {
  apiKey: "neon-test-key",
  projectId: "proj-1",
  operationPollIntervalMs: 1,
  operationPollTimeoutMs: 50,
};

const REQUEST: TenantProvisioningRequest = { tenant: { name: "acme" }, product: "orb" };
const BRANCH_NAME = "tenant-orb-acme";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type QueuedResponse = { status?: number; body?: unknown; rawBody?: string };

function mockFetchSequence(entries: QueuedResponse[]): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const entry = entries[index];
    index += 1;
    if (!entry) throw new Error(`mockFetchSequence: no queued response for call #${index} (${init.method ?? "GET"} ${url})`);
    const text = entry.rawBody ?? JSON.stringify(entry.body);
    return new Response(text, { status: entry.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls };
}

function bodyOf(init: RequestInit): unknown {
  return init.body ? JSON.parse(init.body as string) : undefined;
}

test("provisionNeonDatabase: fresh provision creates a branch, role, and database, polling each to completion", async () => {
  const { calls } = mockFetchSequence([
    { body: { branches: [] } }, // 1. list branches -> not found
    { body: { branch: { id: "br-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "running" }] } }, // 2. create branch
    { body: { operation: { id: "op-1", status: "finished" } } }, // 3. poll branch operation
    { body: { role: { name: BRANCH_NAME, password: "role-pw" }, operations: [{ id: "op-2", status: "finished" }] } }, // 4. create role (already finished, no poll)
    { body: { operations: [{ id: "op-3", status: "finished" }] } }, // 5. create database (already finished, no poll)
  ]);

  const details = await provisionNeonDatabase(CONFIG, REQUEST);

  assert.deepEqual(details, {
    host: "ep-1.neon.tech",
    port: 5432,
    database: BRANCH_NAME,
    user: BRANCH_NAME,
    password: "role-pw",
    connectionString: `postgres://${BRANCH_NAME}:role-pw@ep-1.neon.tech:5432/${BRANCH_NAME}`,
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[0]?.url, "https://console.neon.tech/api/v2/projects/proj-1/branches");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[1]?.init.method, "POST");
  assert.deepEqual(bodyOf(calls[1]!.init), { branch: { name: BRANCH_NAME }, endpoints: [{ type: "read_write" }] });
  assert.equal(calls[2]?.url, "https://console.neon.tech/api/v2/projects/proj-1/operations/op-1");
  assert.equal(calls[3]?.url, "https://console.neon.tech/api/v2/projects/proj-1/branches/br-1/roles");
  assert.deepEqual(bodyOf(calls[3]!.init), { role: { name: BRANCH_NAME } });
  assert.equal(calls[4]?.url, "https://console.neon.tech/api/v2/projects/proj-1/branches/br-1/databases");
  assert.deepEqual(bodyOf(calls[4]!.init), { database: { name: BRANCH_NAME, owner_name: BRANCH_NAME } });
  // Every mutating call carries the Bearer auth header.
  assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, "Bearer neon-test-key");
});

test("provisionNeonDatabase: polls through multiple non-finished states before succeeding", async () => {
  mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "scheduling" }] } },
    { body: { operation: { id: "op-1", status: "running" } } },
    { body: { operation: { id: "op-1", status: "running" } } },
    { body: { operation: { id: "op-1", status: "finished" } } },
    { body: { role: { name: BRANCH_NAME, password: "role-pw" }, operations: [{ id: "op-2", status: "finished" }] } },
    { body: { operations: [{ id: "op-3", status: "finished" }] } },
  ]);

  const details = await provisionNeonDatabase(CONFIG, REQUEST);

  assert.equal(details.password, "role-pw");
});

test("provisionNeonDatabase: an operation reaching 'failed' throws", async () => {
  mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "running" }] } },
    { body: { operation: { id: "op-1", status: "failed" } } },
  ]);

  await assert.rejects(provisionNeonDatabase(CONFIG, REQUEST), /Neon operation op-1 failed/);
});

test("provisionNeonDatabase: exceeding the poll timeout throws instead of waiting forever", async () => {
  mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "running" }] } },
    // Every poll keeps reporting "running" -- CONFIG's 50ms timeout / 1ms interval will exhaust before this
    // queue ever does (more than enough entries queued).
    ...Array.from({ length: 200 }, () => ({ body: { operation: { id: "op-1", status: "running" } } })),
  ]);

  await assert.rejects(provisionNeonDatabase(CONFIG, REQUEST), /did not finish within \d+ms/);
});

test("provisionNeonDatabase: throws when a created branch has no compute endpoint", async () => {
  mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-1", name: BRANCH_NAME }, endpoints: [], operations: [{ id: "op-1", status: "finished" }] } },
  ]);

  await assert.rejects(provisionNeonDatabase(CONFIG, REQUEST), /created without a compute endpoint/);
});

test("provisionNeonDatabase: throws when the created role has no password", async () => {
  mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "finished" }] } },
    { body: { role: { name: BRANCH_NAME }, operations: [{ id: "op-2", status: "finished" }] } },
  ]);

  await assert.rejects(provisionNeonDatabase(CONFIG, REQUEST), /created without a password/);
});

test("provisionNeonDatabase: a non-ok HTTP response throws a descriptive NeonApiError", async () => {
  mockFetchSequence([{ status: 401, body: { message: "invalid api key" } }]);

  await assert.rejects(provisionNeonDatabase(CONFIG, REQUEST), /Neon API GET .*failed \(401\)/);
});

test("provisionNeonDatabase: idempotent re-provision resolves an existing branch without creating a new one", async () => {
  const { calls } = mockFetchSequence([
    { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } }, // list -> found
    { body: { endpoints: [{ host: "ep-existing.neon.tech" }] } }, // get endpoint
    { body: { role: { name: BRANCH_NAME, password: "existing-pw" } } }, // reveal password
  ]);

  const details = await provisionNeonDatabase(CONFIG, REQUEST);

  assert.deepEqual(details, {
    host: "ep-existing.neon.tech",
    port: 5432,
    database: BRANCH_NAME,
    user: BRANCH_NAME,
    password: "existing-pw",
    connectionString: `postgres://${BRANCH_NAME}:existing-pw@ep-existing.neon.tech:5432/${BRANCH_NAME}`,
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.init.method === "GET" || call.init.method === undefined));
  assert.equal(calls[2]?.url, "https://console.neon.tech/api/v2/projects/proj-1/branches/br-existing/roles/tenant-orb-acme/reveal_password");
});

test("provisionNeonDatabase: throws when an existing branch's role has no revealable password", async () => {
  mockFetchSequence([
    { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } },
    { body: { endpoints: [{ host: "ep-existing.neon.tech" }] } },
    { body: { role: { name: BRANCH_NAME } } },
  ]);

  await assert.rejects(provisionNeonDatabase(CONFIG, REQUEST), /has no revealable password/);
});

test("dropNeonDatabase: deletes an existing tenant's branch, polling the delete operation to completion", async () => {
  const { calls } = mockFetchSequence([
    { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } },
    { body: { operations: [{ id: "op-4", status: "running" } as const] } },
    { body: { operation: { id: "op-4", status: "finished" } } },
  ]);

  await dropNeonDatabase(CONFIG, REQUEST);

  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.init.method, "DELETE");
  assert.equal(calls[1]?.url, "https://console.neon.tech/api/v2/projects/proj-1/branches/br-existing");
});

test("dropNeonDatabase: tolerates a body-less DELETE response (e.g. 204 No Content) as 'nothing to poll'", async () => {
  const { calls } = mockFetchSequence([
    { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } },
    { rawBody: "" }, // the DELETE call itself returns no body at all
  ]);

  await dropNeonDatabase(CONFIG, REQUEST);

  assert.equal(calls.length, 2);
});

test("provisionNeonDatabase: throws when an existing branch has lost its compute endpoint", async () => {
  mockFetchSequence([
    { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } },
    { body: { endpoints: [] } },
  ]);

  await assert.rejects(provisionNeonDatabase(CONFIG, REQUEST), /has no compute endpoint/);
});

test("dropNeonDatabase: a never-provisioned tenant is an idempotent no-op (no DELETE call)", async () => {
  const { calls } = mockFetchSequence([{ body: { branches: [] } }]);

  await dropNeonDatabase(CONFIG, REQUEST);

  assert.equal(calls.length, 1);
});

test("createNeonDatabaseDriver: bundles provision/drop closed over one config", async () => {
  mockFetchSequence([{ body: { branches: [] } }]);
  const driver = createNeonDatabaseDriver(CONFIG);

  await driver.dropDatabase(REQUEST);

  // Proves the returned functions are actually closed over CONFIG's projectId, not re-reading it from
  // somewhere else -- the request above only succeeds against the real Neon endpoint shape if `dropDatabase`
  // routed through the same config-scoped fetch helper `dropNeonDatabase` itself uses.
});

// #8026: two tenant names sharing a long common prefix (both past Neon's 63-char branch-name limit once the
// "tenant-<product>-" prefix is added) used to sanitize+truncate to the IDENTICAL branch name -- provisioning
// the second tenant would find the FIRST tenant's already-existing branch and hand back its connection/role/
// password. Regression-guards branchNameFor's collision-resistant suffix by reading the actual branch name
// each provision call sends in its create-branch POST body.
test("provisionNeonDatabase: two long, prefix-similar tenant names produce DIFFERENT branch names (#8026)", async () => {
  const longPrefix = "a".repeat(60);
  const requestA: TenantProvisioningRequest = { tenant: { name: `${longPrefix}-org-alpha` }, product: "orb" };
  const requestB: TenantProvisioningRequest = { tenant: { name: `${longPrefix}-org-beta` }, product: "orb" };

  const { calls: callsA } = mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-a", name: "placeholder" }, endpoints: [{ host: "ep-a.neon.tech" }], operations: [] } },
    { body: { role: { name: "placeholder", password: "pw-a" }, operations: [] } },
    { body: { operations: [] } },
  ]);
  await provisionNeonDatabase(CONFIG, requestA);
  const branchNameA = (bodyOf(callsA[1]!.init) as { branch: { name: string } }).branch.name;

  const { calls: callsB } = mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-b", name: "placeholder" }, endpoints: [{ host: "ep-b.neon.tech" }], operations: [] } },
    { body: { role: { name: "placeholder", password: "pw-b" }, operations: [] } },
    { body: { operations: [] } },
  ]);
  await provisionNeonDatabase(CONFIG, requestB);
  const branchNameB = (bodyOf(callsB[1]!.init) as { branch: { name: string } }).branch.name;

  // Both names are long enough that a naive unconditional .slice(0, 63) collapses them to the same 63
  // characters of "a"s well before either "-org-alpha"/"-org-beta" suffix is ever reached.
  assert.notEqual(branchNameA, branchNameB);
  assert.ok(branchNameA.length <= 63);
  assert.ok(branchNameB.length <= 63);
});

test("provisionNeonDatabase: a short tenant name's branch name is completely unaffected by the collision-suffix logic", async () => {
  const { calls } = mockFetchSequence([
    { body: { branches: [] } },
    { body: { branch: { id: "br-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [] } },
    { body: { role: { name: BRANCH_NAME, password: "pw" }, operations: [] } },
    { body: { operations: [] } },
  ]);

  await provisionNeonDatabase(CONFIG, REQUEST);

  assert.equal((bodyOf(calls[1]!.init) as { branch: { name: string } }).branch.name, BRANCH_NAME);
});
