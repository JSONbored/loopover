import { describe, expect, it, vi } from "vitest";
import { createMinerOpsActions } from "../../packages/loopover-miner/lib/miner-ops-actions";

// #9523: the store operations behind the miner's mutating MCP tools. Every seam is injected here, so these
// assert the wiring — which store call each action makes, and that every store it opens is closed — without
// touching disk. The governor gate in front of them is covered by miner-mcp-governor-gating.test.ts.

function fakeQueue(overrides: Record<string, unknown> = {}) {
  const closed = { count: 0 };
  const store = {
    reclaimStuckItem: vi.fn(() => ({ id: "entry" })),
    requeueItem: vi.fn(() => ({ id: "entry" })),
    close: vi.fn(() => {
      closed.count += 1;
    }),
    ...overrides,
  };
  return { store, closed };
}

describe("releaseQueueItem", () => {
  it("reclaims the lease by the item's string identifier and closes the store", () => {
    const { store, closed } = fakeQueue();
    const actions = createMinerOpsActions({ initPortfolioQueue: () => store as never });
    expect(actions.releaseQueueItem({ repoFullName: "owner/repo", issueNumber: 12 })).toEqual({ released: true, entry: { id: "entry" } });
    // The queue keys items by a STRING identifier; an issue number must be stringified, not passed raw.
    expect(store.reclaimStuckItem).toHaveBeenCalledWith("owner/repo", "12");
    expect(closed.count).toBe(1);
  });

  it("reports released=false when the item was not held, and still closes", () => {
    const { store, closed } = fakeQueue({ reclaimStuckItem: vi.fn(() => null) });
    const actions = createMinerOpsActions({ initPortfolioQueue: () => store as never });
    expect(actions.releaseQueueItem({ repoFullName: "owner/repo", issueNumber: 1 })).toEqual({ released: false, entry: null });
    expect(closed.count).toBe(1);
  });

  it("closes the store even when the operation throws", () => {
    const { store, closed } = fakeQueue({
      reclaimStuckItem: vi.fn(() => {
        throw new Error("db locked");
      }),
    });
    const actions = createMinerOpsActions({ initPortfolioQueue: () => store as never });
    expect(() => actions.releaseQueueItem({ repoFullName: "owner/repo", issueNumber: 1 })).toThrow("db locked");
    expect(closed.count, "a thrown operation must not leak the handle").toBe(1);
  });
});

describe("requeueQueueItem", () => {
  it("requeues by identifier and closes", () => {
    const { store, closed } = fakeQueue();
    const actions = createMinerOpsActions({ initPortfolioQueue: () => store as never });
    expect(actions.requeueQueueItem({ repoFullName: "owner/repo", issueNumber: 7 })).toEqual({ requeued: true, entry: { id: "entry" } });
    expect(store.requeueItem).toHaveBeenCalledWith("owner/repo", "7");
    expect(closed.count).toBe(1);
  });

  it("reports requeued=false for an unknown item", () => {
    const { store } = fakeQueue({ requeueItem: vi.fn(() => null) });
    const actions = createMinerOpsActions({ initPortfolioQueue: () => store as never });
    expect(actions.requeueQueueItem({ repoFullName: "owner/repo", issueNumber: 7 })).toEqual({ requeued: false, entry: null });
  });
});

describe("releaseClaim", () => {
  it("releases the claim by NUMBER — the claim ledger keys by issue number, unlike the queue", () => {
    const close = vi.fn();
    const releaseClaim = vi.fn(() => ({ status: "released" }));
    const actions = createMinerOpsActions({ openClaims: () => ({ releaseClaim, close }) as never });
    expect(actions.releaseClaim({ repoFullName: "owner/repo", issueNumber: 3 })).toEqual({ released: true, entry: { status: "released" } });
    expect(releaseClaim).toHaveBeenCalledWith("owner/repo", 3);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports released=false when there was no claim", () => {
    const actions = createMinerOpsActions({ openClaims: () => ({ releaseClaim: () => null, close: vi.fn() }) as never });
    expect(actions.releaseClaim({ repoFullName: "owner/repo", issueNumber: 3 })).toEqual({ released: false, entry: null });
  });
});

describe("decideDenyHook", () => {
  it("approves a proposal it can find in that repo", () => {
    const setProposalStatus = vi.fn();
    const close = vi.fn();
    const actions = createMinerOpsActions({
      openDenyHooks: () => ({ listProposals: () => [{ id: "hook-1" }], setProposalStatus, close }) as never,
    });
    expect(actions.decideDenyHook({ repoFullName: "owner/repo", hookId: "hook-1", decision: "approve" })).toEqual({
      decided: true,
      hookId: "hook-1",
      status: "approved",
    });
    expect(setProposalStatus).toHaveBeenCalledWith("owner/repo", "hook-1", "approved");
    expect(close).toHaveBeenCalledOnce();
  });

  it("maps reject to the rejected status", () => {
    const setProposalStatus = vi.fn();
    const actions = createMinerOpsActions({
      openDenyHooks: () => ({ listProposals: () => [{ id: "hook-2" }], setProposalStatus, close: vi.fn() }) as never,
    });
    expect(actions.decideDenyHook({ repoFullName: "owner/repo", hookId: "hook-2", decision: "reject" })).toMatchObject({ status: "rejected" });
  });

  it("reports notFound WITHOUT writing when the proposal is not in that repo", () => {
    const setProposalStatus = vi.fn();
    const actions = createMinerOpsActions({
      openDenyHooks: () => ({ listProposals: () => [{ id: "other" }], setProposalStatus, close: vi.fn() }) as never,
    });
    expect(actions.decideDenyHook({ repoFullName: "owner/repo", hookId: "missing", decision: "approve" })).toEqual({
      decided: false,
      notFound: true,
      hookId: "missing",
    });
    expect(setProposalStatus, "an unknown proposal must not be written").not.toHaveBeenCalled();
  });
});

describe("runMigrations", () => {
  it("reports ok when every store migrated cleanly", () => {
    const actions = createMinerOpsActions({
      migrate: () => [
        { name: "a", ok: true, status: "migrated" },
        { name: "b", ok: true, status: "up-to-date" },
      ] as never,
    });
    expect(actions.runMigrations()).toMatchObject({ ok: true });
  });

  it("reports ok=false when ANY store failed — a partial sweep is not a success", () => {
    const actions = createMinerOpsActions({
      migrate: () => [
        { name: "a", ok: true, status: "migrated" },
        { name: "b", ok: false, status: "failed" },
      ] as never,
    });
    expect(actions.runMigrations()).toMatchObject({ ok: false });
  });
});

describe("purgeRepo", () => {
  it("delegates to the CLI's own purge core, so both surfaces cover the same stores", () => {
    const purge = vi.fn(() => ({ outcome: "purged", totalPurged: 4 }));
    const actions = createMinerOpsActions({ purge: purge as never });
    expect(actions.purgeRepo({ repoFullName: "owner/repo" })).toEqual({ outcome: "purged", totalPurged: 4 });
    expect(purge).toHaveBeenCalledWith("owner/repo");
  });
});
