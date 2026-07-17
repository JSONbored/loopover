import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LEASE_MS,
  openWorktreeAllocator,
} from "../../packages/loopover-miner/lib/worktree-allocator.js";

// Cross-container orphan reclaim (#7085): fleet mode runs separate CONTAINERS over one shared store, each with
// its own PID namespace, so `owner_pid` is a meaningless signal across containers. These tests seed active rows
// with controlled owner_pid/owner_host/allocated_at and open the allocator with an injected hostId + nowMs to
// prove the age-based reclaim (not the same-host pid fast path) governs the cross-container case.

const roots: string[] = [];
const allocators: Array<{ close(): void }> = [];

const NOW_MS = Date.parse("2026-07-17T12:00:00.000Z");
const RECENT = "2026-07-17T11:59:00.000Z"; // ~1 minute before NOW_MS — well within any lease
const OLD = "2026-07-17T00:00:00.000Z"; // 12 hours before NOW_MS — past the 6h default lease
const DEAD_PID = 9_999_999; // absent in this test runner's PID namespace, so isProcessAlive() returns false

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-worktree-lease-"));
  roots.push(root);
  return {
    dbPath: join(root, "worktree-allocator.sqlite3"),
    worktreeBaseDir: join(root, "worktrees"),
  };
}

/** Bootstrap the store schema/slots, then hand-write one active slot with fully controlled lease fields. */
function seedActiveSlot(
  paths: ReturnType<typeof tempPaths>,
  seed: { ownerPid: number | null; ownerHost: string | null; allocatedAt: string | null },
) {
  const bootstrap = openWorktreeAllocator({
    dbPath: paths.dbPath,
    worktreeBaseDir: paths.worktreeBaseDir,
    maxConcurrency: 1,
  });
  bootstrap.close();

  const db = new DatabaseSync(paths.dbPath);
  try {
    db.prepare(`
      UPDATE worktree_slots
      SET status = 'active',
          attempt_id = 'seeded-attempt',
          repo_full_name = 'acme/widgets',
          owner_pid = ?,
          owner_host = ?,
          allocated_at = ?
      WHERE slot_index = 0
    `).run(seed.ownerPid, seed.ownerHost, seed.allocatedAt);
  } finally {
    db.close();
  }
}

function reopen(
  paths: ReturnType<typeof tempPaths>,
  options: { hostId: string; nowMs?: number; maxLeaseMs?: number },
) {
  const allocator = openWorktreeAllocator({
    dbPath: paths.dbPath,
    worktreeBaseDir: paths.worktreeBaseDir,
    maxConcurrency: 1,
    hostId: options.hostId,
    nowMs: options.nowMs ?? NOW_MS,
    ...(options.maxLeaseMs === undefined ? {} : { maxLeaseMs: options.maxLeaseMs }),
  });
  allocators.push(allocator);
  return allocator;
}

function activeCount(allocator: ReturnType<typeof reopen>) {
  return allocator.listSlots().filter((slot) => slot.status === "active").length;
}

afterEach(() => {
  for (const allocator of allocators.splice(0)) allocator.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner worktree allocator age-based orphan reclaim (#7085)", () => {
  it("exposes a lease default at least as generous as portfolio-queue-expiry's 30-minute floor", () => {
    expect(DEFAULT_MAX_LEASE_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it("does NOT reclaim a recent slot whose foreign owner_pid is dead in this namespace (cross-container false-negative)", () => {
    // container-A recorded a still-running worker; container-B observes that pid as dead only because it is a
    // different PID namespace. The age guard must protect the live worker's slot.
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: DEAD_PID, ownerHost: "container-A", allocatedAt: RECENT });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(1);
    expect(() => allocator.acquire("intruder", "acme/other")).toThrow("worktree_capacity_exceeded");
  });

  it("reclaims a stale slot whose foreign owner_pid collides with a live local pid (cross-container false-positive)", () => {
    // container-A's recorded pid happens to match a live pid in container-B's namespace, so isProcessAlive would
    // wrongly say "alive" — but the lease is past its deadline, so age reclaims it regardless.
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: process.pid, ownerHost: "container-A", allocatedAt: OLD });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(0);
    expect(allocator.acquire("fresh", "acme/other").status).toBe("active");
  });

  it("reclaims a past-lease slot even when its owner pid is alive on the SAME host (age overrides pid)", () => {
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: process.pid, ownerHost: "container-B", allocatedAt: OLD });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(0);
  });

  it("keeps a within-lease slot whose owner pid is alive on the SAME host", () => {
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: process.pid, ownerHost: "container-B", allocatedAt: RECENT });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(1);
  });

  it("reclaims a within-lease slot immediately when its owner pid is dead on the SAME host (fast path)", () => {
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: DEAD_PID, ownerHost: "container-B", allocatedAt: RECENT });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(0);
  });

  it("reclaims a within-lease slot with no recorded owner pid on the SAME host", () => {
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: null, ownerHost: "container-B", allocatedAt: RECENT });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(0);
  });

  it("keeps a within-lease legacy slot with no recorded owner_host until it ages out", () => {
    // A row migrated from a pre-#7085 store has owner_host NULL, so the same-host pid fast path can never apply;
    // only the age fallback governs it.
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: DEAD_PID, ownerHost: null, allocatedAt: RECENT });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(1);
  });

  it("reclaims a slot whose owner_host is unset once its lease is past due", () => {
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: DEAD_PID, ownerHost: null, allocatedAt: OLD });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(0);
  });

  it("reclaims a same-host slot with a dead owner even when allocated_at is missing", () => {
    // Defensive: a corrupt active row with no parseable allocated_at yields a null age, so the age guard is
    // skipped and the same-host pid check still frees it.
    const paths = tempPaths();
    seedActiveSlot(paths, { ownerPid: DEAD_PID, ownerHost: "container-B", allocatedAt: null });
    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(0);
  });

  it("honors a caller-supplied maxLeaseMs shorter than the default", () => {
    const paths = tempPaths();
    // 5 minutes old: within the 6h default, but past a 1-minute override.
    seedActiveSlot(paths, {
      ownerPid: process.pid,
      ownerHost: "container-B",
      allocatedAt: "2026-07-17T11:55:00.000Z",
    });
    const allocator = reopen(paths, { hostId: "container-B", maxLeaseMs: 60_000 });
    expect(activeCount(allocator)).toBe(0);
  });

  it("rejects invalid lease and host configuration", () => {
    const paths = tempPaths();
    const base = { dbPath: paths.dbPath, worktreeBaseDir: paths.worktreeBaseDir, maxConcurrency: 1 };
    expect(() => openWorktreeAllocator({ ...base, maxLeaseMs: -1 })).toThrow("invalid_max_lease_ms");
    expect(() => openWorktreeAllocator({ ...base, maxLeaseMs: Number.NaN })).toThrow("invalid_max_lease_ms");
    expect(() => openWorktreeAllocator({ ...base, hostId: "  " })).toThrow("invalid_host_id");
  });

  it("adds the owner_host column to a pre-#7085 store on open and reclaims its stale rows by age", () => {
    const paths = tempPaths();
    // A file created before #7085 has no owner_host column. `CREATE TABLE IF NOT EXISTS` won't touch it, so the
    // open path must ALTER it in — and the stale legacy active row (dead pid, past-due lease) must still reclaim.
    const legacy = new DatabaseSync(paths.dbPath);
    try {
      legacy.exec(`
        CREATE TABLE worktree_slots (
          slot_index INTEGER PRIMARY KEY,
          worktree_path TEXT NOT NULL UNIQUE,
          attempt_id TEXT UNIQUE,
          repo_full_name TEXT,
          status TEXT NOT NULL CHECK (status IN ('free', 'active')),
          owner_pid INTEGER,
          allocated_at TEXT
        )
      `);
      legacy
        .prepare(`
          INSERT INTO worktree_slots (slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, allocated_at)
          VALUES (0, ?, 'legacy-attempt', 'acme/widgets', 'active', ?, ?)
        `)
        .run(join(paths.worktreeBaseDir, "slot-0"), DEAD_PID, OLD);
    } finally {
      legacy.close();
    }

    const allocator = reopen(paths, { hostId: "container-B" });
    expect(activeCount(allocator)).toBe(0);
    // A successful acquire proves the column was added — markActive writes owner_host and would throw otherwise.
    expect(allocator.acquire("fresh", "acme/other").ownerHost).toBe("container-B");
  });

  it("stamps the acquiring host and pid onto the allocation and clears them on release", () => {
    const paths = tempPaths();
    const allocator = reopen(paths, { hostId: "container-B" });
    const allocation = allocator.acquire("attempt-a", "acme/widgets");
    expect(allocation.ownerHost).toBe("container-B");
    expect(allocation.ownerPid).toBe(process.pid);
    expect(allocator.release("attempt-a")?.ownerHost).toBeNull();
  });
});
