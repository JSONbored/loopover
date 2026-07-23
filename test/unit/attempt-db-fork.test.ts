// Tests for the Neon branch-per-attempt disposable DB fork (#7858). No live Neon account or credentials
// anywhere here -- globalThis.fetch is stubbed with a strict, ordered response queue for every test, mirroring
// control-plane/test/neon-database-driver.test.ts's identical convention (this module deliberately mirrors
// that file's own already-reviewed Neon-calling pattern).
//
// SCOPE NOTE: what these tests CAN verify is that this module makes the correct Neon API calls in the correct
// order/shape, including scoping each attempt to its own distinct branch. What they CANNOT verify -- and what
// no test in this repo can verify without a live Neon account -- is Neon's own platform guarantee that a
// branch's data is actually isolated from its parent and from sibling branches. That isolation guarantee is
// Neon's responsibility, not this module's; this module's responsibility (and this file's actual coverage) is
// requesting the right branch, off the right parent, discarded at the right time.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAttemptDbFork,
  discardAttemptDbFork,
  type AttemptDbForkConfig,
} from "../../packages/loopover-engine/src/miner/attempt-db-fork";

const CONFIG: AttemptDbForkConfig = {
  apiKey: "neon-test-key",
  projectId: "proj-1",
  parentBranchId: "br-parent",
  operationPollIntervalMs: 1,
  operationPollTimeoutMs: 50,
};

const ATTEMPT_ID = "JSONbored_loopover-123-1700000000000";
const BRANCH_NAME = "attempt-jsonbored_loopover-123-1700000000000";

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

describe("createAttemptDbFork", () => {
  it("fresh create: forks off parentBranchId, inherits the parent's database, creates a fresh role", async () => {
    const { calls } = mockFetchSequence([
      { body: { branches: [] } }, // 1. list branches -> not found
      { body: { databases: [{ name: "tenant-db" }] } }, // 2. parent's database name
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "finished" }] } }, // 3. create branch
      { body: { role: { name: BRANCH_NAME, password: "role-pw" }, operations: [{ id: "op-2", status: "finished" }] } }, // 4. create role
    ]);

    const fork = await createAttemptDbFork(CONFIG, ATTEMPT_ID);

    expect(fork).toEqual({
      branchId: "br-attempt-1",
      connectionString: `postgres://${BRANCH_NAME}:role-pw@ep-1.neon.tech:5432/tenant-db`,
    });

    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe("https://console.neon.tech/api/v2/projects/proj-1/branches");
    expect(calls[1]?.url).toBe("https://console.neon.tech/api/v2/projects/proj-1/branches/br-parent/databases");
    expect(calls[2]?.init.method).toBe("POST");
    expect(bodyOf(calls[2]!.init)).toEqual({ branch: { name: BRANCH_NAME, parent_id: "br-parent" }, endpoints: [{ type: "read_write" }] });
    expect(calls[3]?.url).toBe("https://console.neon.tech/api/v2/projects/proj-1/branches/br-attempt-1/roles");
    expect(bodyOf(calls[3]!.init)).toEqual({ role: { name: BRANCH_NAME } });
    expect((calls[2]!.init.headers as Record<string, string>).authorization).toBe("Bearer neon-test-key");
  });

  it("polls a not-yet-finished branch-creation operation to completion", async () => {
    mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "running" }] } },
      { body: { operation: { id: "op-1", status: "running" } } },
      { body: { operation: { id: "op-1", status: "finished" } } },
      { body: { role: { name: BRANCH_NAME, password: "role-pw" }, operations: [{ id: "op-2", status: "finished" }] } },
    ]);

    const fork = await createAttemptDbFork(CONFIG, ATTEMPT_ID);
    expect(fork.branchId).toBe("br-attempt-1");
  });

  it("falls back to the real default poll interval/timeout when config omits them (exercised via an already-finished operation, so no real 500ms wait occurs)", async () => {
    const configWithoutPollOverrides: AttemptDbForkConfig = { apiKey: "neon-test-key", projectId: "proj-1", parentBranchId: "br-parent" };
    mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "finished" }] } },
      { body: { role: { name: BRANCH_NAME, password: "role-pw" }, operations: [{ id: "op-2", status: "finished" }] } },
    ]);

    const fork = await createAttemptDbFork(configWithoutPollOverrides, ATTEMPT_ID);
    expect(fork.branchId).toBe("br-attempt-1");
  });

  it("an operation reaching 'failed' throws", async () => {
    mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "running" }] } },
      { body: { operation: { id: "op-1", status: "failed" } } },
    ]);

    await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/Neon operation op-1 failed/);
  });

  it("exceeding the poll timeout throws instead of waiting forever", async () => {
    mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "running" }] } },
      ...Array.from({ length: 200 }, () => ({ body: { operation: { id: "op-1", status: "running" } } })),
    ]);

    await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/did not finish within \d+ms/);
  });

  it("throws when the parent branch has no database to fork", async () => {
    mockFetchSequence([{ body: { branches: [] } }, { body: { databases: [] } }]);

    await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/parent branch br-parent has no database/);
  });

  it("throws when a created branch has no compute endpoint", async () => {
    mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [], operations: [{ id: "op-1", status: "finished" }] } },
    ]);

    await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/created without a compute endpoint/);
  });

  it("throws when the created role has no password", async () => {
    mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [{ id: "op-1", status: "finished" }] } },
      { body: { role: { name: BRANCH_NAME }, operations: [{ id: "op-2", status: "finished" }] } },
    ]);

    await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/created without a password/);
  });

  it("a non-ok HTTP response throws a descriptive NeonApiError", async () => {
    mockFetchSequence([{ status: 401, body: { message: "invalid api key" } }]);

    await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/Neon API GET .*failed \(401\)/);
  });

  describe("idempotent re-create (retry for the same attemptId)", () => {
    it("resolves the already-existing branch instead of creating a duplicate", async () => {
      const { calls } = mockFetchSequence([
        { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } }, // list -> found
        { body: { endpoints: [{ host: "ep-existing.neon.tech" }] } }, // get endpoint
        { body: { role: { name: BRANCH_NAME, password: "existing-pw" } } }, // reveal password
        { body: { databases: [{ name: "tenant-db" }] } }, // parent's database name
      ]);

      const fork = await createAttemptDbFork(CONFIG, ATTEMPT_ID);

      expect(fork).toEqual({
        branchId: "br-existing",
        connectionString: `postgres://${BRANCH_NAME}:existing-pw@ep-existing.neon.tech:5432/tenant-db`,
      });
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => call.init.method === "GET" || call.init.method === undefined)).toBe(true);
      expect(calls[2]?.url).toBe(`https://console.neon.tech/api/v2/projects/proj-1/branches/br-existing/roles/${BRANCH_NAME}/reveal_password`);
    });

    it("throws when the existing branch has lost its compute endpoint", async () => {
      mockFetchSequence([{ body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } }, { body: { endpoints: [] } }]);

      await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/has no compute endpoint/);
    });

    it("throws when the existing branch's role has no revealable password", async () => {
      mockFetchSequence([
        { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } },
        { body: { endpoints: [{ host: "ep-existing.neon.tech" }] } },
        { body: { role: { name: BRANCH_NAME } } },
      ]);

      await expect(createAttemptDbFork(CONFIG, ATTEMPT_ID)).rejects.toThrow(/has no revealable password/);
    });
  });

  it("two different attempt ids are scoped to two DISTINCT branches, each forked off the SAME parentBranchId", async () => {
    const { calls: callsA } = mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-a", name: "placeholder" }, endpoints: [{ host: "ep-a.neon.tech" }], operations: [] } },
      { body: { role: { name: "placeholder", password: "pw-a" }, operations: [] } },
    ]);
    const forkA = await createAttemptDbFork(CONFIG, "attempt-a");

    const { calls: callsB } = mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-b", name: "placeholder" }, endpoints: [{ host: "ep-b.neon.tech" }], operations: [] } },
      { body: { role: { name: "placeholder", password: "pw-b" }, operations: [] } },
    ]);
    const forkB = await createAttemptDbFork(CONFIG, "attempt-b");

    expect(forkA.branchId).not.toBe(forkB.branchId);
    expect(forkA.connectionString).not.toBe(forkB.connectionString);
    const nameA = (bodyOf(callsA[2]!.init) as { branch: { name: string; parent_id: string } }).branch;
    const nameB = (bodyOf(callsB[2]!.init) as { branch: { name: string; parent_id: string } }).branch;
    expect(nameA.name).not.toBe(nameB.name);
    expect(nameA.parent_id).toBe("br-parent");
    expect(nameB.parent_id).toBe("br-parent");
  });

  // #8026-style regression (see neon-database-driver.ts's own identical guard): two attempt ids sharing a long
  // common prefix must not collapse to the same truncated (63-char) branch name, or the second attempt would
  // resolve the FIRST attempt's already-existing branch instead of getting its own isolated fork.
  it("REGRESSION: two long, prefix-similar attempt ids produce DIFFERENT branch names", async () => {
    const longPrefix = "a".repeat(60);

    const { calls: callsA } = mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-a", name: "placeholder" }, endpoints: [{ host: "ep-a.neon.tech" }], operations: [] } },
      { body: { role: { name: "placeholder", password: "pw-a" }, operations: [] } },
    ]);
    await createAttemptDbFork(CONFIG, `${longPrefix}-alpha`);
    const branchNameA = (bodyOf(callsA[2]!.init) as { branch: { name: string } }).branch.name;

    const { calls: callsB } = mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-b", name: "placeholder" }, endpoints: [{ host: "ep-b.neon.tech" }], operations: [] } },
      { body: { role: { name: "placeholder", password: "pw-b" }, operations: [] } },
    ]);
    await createAttemptDbFork(CONFIG, `${longPrefix}-beta`);
    const branchNameB = (bodyOf(callsB[2]!.init) as { branch: { name: string } }).branch.name;

    expect(branchNameA).not.toBe(branchNameB);
    expect(branchNameA.length).toBeLessThanOrEqual(63);
    expect(branchNameB.length).toBeLessThanOrEqual(63);
  });

  it("a short attempt id's branch name is completely unaffected by the collision-suffix logic", async () => {
    const { calls } = mockFetchSequence([
      { body: { branches: [] } },
      { body: { databases: [{ name: "tenant-db" }] } },
      { body: { branch: { id: "br-attempt-1", name: BRANCH_NAME }, endpoints: [{ host: "ep-1.neon.tech" }], operations: [] } },
      { body: { role: { name: BRANCH_NAME, password: "pw" }, operations: [] } },
    ]);

    await createAttemptDbFork(CONFIG, ATTEMPT_ID);

    expect((bodyOf(calls[2]!.init) as { branch: { name: string } }).branch.name).toBe(BRANCH_NAME);
  });
});

describe("discardAttemptDbFork", () => {
  it("deletes an existing attempt branch, polling the delete operation to completion", async () => {
    const { calls } = mockFetchSequence([
      { body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } },
      { body: { operations: [{ id: "op-4", status: "running" }] } },
      { body: { operation: { id: "op-4", status: "finished" } } },
    ]);

    await discardAttemptDbFork(CONFIG, ATTEMPT_ID);

    expect(calls).toHaveLength(3);
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[1]?.url).toBe("https://console.neon.tech/api/v2/projects/proj-1/branches/br-existing");
  });

  it("tolerates a body-less DELETE response (e.g. 204 No Content) as 'nothing to poll'", async () => {
    const { calls } = mockFetchSequence([{ body: { branches: [{ id: "br-existing", name: BRANCH_NAME }] } }, { rawBody: "" }]);

    await discardAttemptDbFork(CONFIG, ATTEMPT_ID);

    expect(calls).toHaveLength(2);
  });

  it("an attempt whose branch was never created (or already discarded) is an idempotent no-op -- no DELETE call", async () => {
    const { calls } = mockFetchSequence([{ body: { branches: [] } }]);

    await discardAttemptDbFork(CONFIG, ATTEMPT_ID);

    expect(calls).toHaveLength(1);
  });
});
