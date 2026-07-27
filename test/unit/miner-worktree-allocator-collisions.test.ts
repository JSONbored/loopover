import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDefaultWorktreeAllocator,
  openWorktreeAllocator,
} from "../../packages/loopover-miner/lib/worktree-allocator";

const acquireChildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/miner-worktree-allocator/acquire-child.mjs",
);

const roots: string[] = [];
const allocators: Array<{ close(): void }> = [];

type AcquireChildResult = {
  ok: boolean;
  allocation?: { worktreePath: string; attemptId: string; status: string };
  message?: string;
};

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-worktree-collisions-"));
  roots.push(root);
  return {
    root,
    dbPath: join(root, "worktree-allocator.sqlite3"),
    worktreeBaseDir: join(root, "worktrees"),
  };
}

function openAllocator(
  paths: ReturnType<typeof tempPaths>,
  options: { maxConcurrency?: number; processPid?: number } = {},
) {
  const allocator = openWorktreeAllocator({
    dbPath: paths.dbPath,
    worktreeBaseDir: paths.worktreeBaseDir,
    maxConcurrency: options.maxConcurrency ?? 4,
    ...(options.processPid === undefined ? {} : { processPid: options.processPid }),
  });
  allocators.push(allocator);
  return allocator;
}

function bootstrapSharedStore(paths: ReturnType<typeof tempPaths>, maxConcurrency: number) {
  const bootstrap = openWorktreeAllocator({
    dbPath: paths.dbPath,
    worktreeBaseDir: paths.worktreeBaseDir,
    maxConcurrency,
  });
  bootstrap.close();
}

function spawnAcquireChild(
  paths: ReturnType<typeof tempPaths>,
  attemptId: string,
  maxConcurrency: number,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [
      acquireChildScript,
      paths.dbPath,
      paths.worktreeBaseDir,
      String(maxConcurrency),
      attemptId,
      "acme/widgets",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  // The done-broadcast can race a child that already exited (a rejected acquire exits immediately) — an
  // unhandled EPIPE on its stdin must not crash the test run.
  child.stdin.on("error", () => {});
  return child;
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.includes("READY\n")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`child exited before READY (${code})`));
    });
  });
}

async function runBarrieredAcquires(
  paths: ReturnType<typeof tempPaths>,
  attemptIds: string[],
  maxConcurrency: number,
): Promise<AcquireChildResult[]> {
  const children = attemptIds.map((attemptId) => spawnAcquireChild(paths, attemptId, maxConcurrency));
  await Promise.all(children.map((child) => waitForReady(child)));
  for (const child of children) child.stdin.write("go\n");
  // #8992: results resolve from STDOUT, not exit — a successful child HOLDS its lease (process alive) until
  // every result is observed. The previous exit-after-acquire lifecycle let later children's on-acquire
  // sweeps legitimately reclaim the dead winners' slots and re-issue the same paths (the CI 4-of-5 /
  // 2-of-5-distinct flake), and could hand the capacity test a third success at a 2-slot cap.
  const results = await Promise.all(
    children.map(
      (child) =>
        new Promise<AcquireChildResult>((resolve, reject) => {
          let stdout = "";
          const onData = (chunk: Buffer | string) => {
            stdout += chunk.toString();
            const line = stdout
              .split("\n")
              .map((entry) => entry.trim())
              .find((entry) => entry.startsWith("{"));
            if (line) {
              child.stdout.off("data", onData);
              resolve(JSON.parse(line) as AcquireChildResult);
            }
          };
          child.stdout.on("data", onData);
          child.once("error", reject);
          child.once("exit", () => {
            if (!stdout.includes("{")) reject(new Error(`child exited with no JSON result: ${stdout}`));
          });
        }),
    ),
  );
  // Every lease observed — release the survivors and wait for them to exit cleanly.
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.stdin.write("done\n");
        }),
    ),
  );
  return results;
}

afterEach(() => {
  for (const allocator of allocators.splice(0)) allocator.close();
  closeDefaultWorktreeAllocator();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner worktree allocator collisions (#4298)", () => {
  it("returns distinct worktree paths when multiple processes acquire simultaneously", async () => {
    const paths = tempPaths();
    const maxConcurrency = 5;
    bootstrapSharedStore(paths, maxConcurrency);
    const results = await runBarrieredAcquires(
      paths,
      Array.from({ length: maxConcurrency }, (_, index) => `attempt-${index}`),
      maxConcurrency,
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const worktreePaths = results.map((result) => result.allocation?.worktreePath ?? "");
    expect(new Set(worktreePaths).size).toBe(maxConcurrency);
  });

  it("rejects excess simultaneous cross-process acquire calls at the concurrency cap", async () => {
    const paths = tempPaths();
    const maxConcurrency = 2;
    bootstrapSharedStore(paths, maxConcurrency);
    const results = await runBarrieredAcquires(
      paths,
      ["attempt-1", "attempt-2", "attempt-3"],
      maxConcurrency,
    );
    const fulfilled = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.message).toBe("worktree_capacity_exceeded");
  });

  it("returns the same allocation when two processes race on one attempt id", async () => {
    const paths = tempPaths();
    bootstrapSharedStore(paths, 2);
    const results = await runBarrieredAcquires(paths, ["shared-attempt", "shared-attempt"], 2);
    expect(results.every((result) => result.ok)).toBe(true);
    const worktreePaths = results.map((result) => result.allocation?.worktreePath ?? "");
    expect(worktreePaths[0]).toBe(worktreePaths[1]);
  });

  it("rejects the acquire-child helper when required args are missing", async () => {
    const child = spawn(process.execPath, [acquireChildScript], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(2);
  });

  it("reuses a worktree path after release", () => {
    const paths = tempPaths();
    const allocator = openAllocator(paths, { maxConcurrency: 1 });
    const first = allocator.acquire("attempt-a", "acme/widgets");
    allocator.release("attempt-a");
    const second = allocator.acquire("attempt-b", "acme/widgets");
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.status).toBe("active");
  });

  it("reclaims orphaned active allocations after a simulated crash on reopen", () => {
    const paths = tempPaths();
    const crashedPid = 40_001;
    const restartedPid = 40_002;

    const crashed = openAllocator(paths, { maxConcurrency: 1, processPid: crashedPid });
    const allocation = crashed.acquire("attempt-dead", "acme/widgets");
    crashed.close();
    allocators.pop();

    const restarted = openAllocator(paths, { maxConcurrency: 1, processPid: restartedPid });
    expect(restarted.listSlots().find((slot) => slot.status === "active")).toBeUndefined();

    const reclaimed = restarted.acquire("attempt-new", "acme/other");
    expect(reclaimed.worktreePath).toBe(allocation.worktreePath);
    expect(reclaimed.attemptId).toBe("attempt-new");
  });

  it("reclaims a manually seeded active row with no live owner", () => {
    const paths = tempPaths();
    mkdirSeed(paths, 50_001);

    const restarted = openAllocator(paths, { maxConcurrency: 2, processPid: 50_002 });
    expect(restarted.acquire("attempt-live", "acme/widgets").status).toBe("active");
    expect(restarted.listSlots().filter((slot) => slot.status === "active")).toHaveLength(1);
  });

  it("does not reclaim active slots owned by another live process on reopen", () => {
    const paths = tempPaths();
    const ownerPid = process.pid;

    const owner = openAllocator(paths, { maxConcurrency: 1, processPid: ownerPid });
    const allocation = owner.acquire("attempt-live-owner", "acme/widgets");
    owner.close();
    allocators.pop();

    const peer = openAllocator(paths, { maxConcurrency: 1, processPid: 99_999 });
    const active = peer.listSlots().find((slot) => slot.status === "active");
    expect(active).toMatchObject({
      attemptId: "attempt-live-owner",
      worktreePath: allocation.worktreePath,
      ownerPid,
    });
    expect(() => peer.acquire("attempt-peer", "acme/other")).toThrow("worktree_capacity_exceeded");
  });
});

function mkdirSeed(paths: ReturnType<typeof tempPaths>, ownerPid: number) {
  const bootstrap = openWorktreeAllocator({
    dbPath: paths.dbPath,
    worktreeBaseDir: paths.worktreeBaseDir,
    maxConcurrency: 2,
    processPid: ownerPid,
  });
  bootstrap.close();

  const db = new DatabaseSync(paths.dbPath);
  try {
    db.prepare(`
      UPDATE worktree_slots
      SET status = 'active',
          attempt_id = 'orphan-attempt',
          repo_full_name = 'acme/widgets',
          owner_pid = ?,
          allocated_at = '2026-07-08T12:00:00.000Z'
      WHERE slot_index = 0
    `).run(ownerPid);
    db.prepare(`
      UPDATE worktree_slots
      SET status = 'active',
          attempt_id = 'orphan-attempt-2',
          repo_full_name = 'acme/other',
          owner_pid = ?,
          allocated_at = '2026-07-08T12:00:00.000Z'
      WHERE slot_index = 1
    `).run(ownerPid);
  } finally {
    db.close();
  }
}
