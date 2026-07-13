import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { sweepStuckItems } from "../../packages/gittensory-miner/lib/portfolio-queue-expiry.js";

// Real crash-recovery coverage for portfolio-queue's stuck-item lease/reclaim mechanism (#4868). The
// existing unit suite (test/unit/miner-portfolio-queue-expiry.test.ts) only exercises sweepStuckItems
// in-process against fake timers -- it never actually kills a process mid-claim. This spawns a real Node
// child process that claims the only queued item (stamping a real on-disk lease) and then idles forever
// (never marks done, never closes cleanly), SIGKILLs it to simulate a crash, and verifies the item is left
// genuinely stuck 'in_progress' until its lease expires, at which point the sweep reclaims it and it
// becomes claimable again -- the full crash -> detect -> reclaim -> re-claim cycle.
//
// Scope note (per the issue): this only tests portfolio-queue's own single-miner crash/reclaim behavior. It
// does not touch, and must not be extended into, cross-miner claim-conflict resolution.

const holdChildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/miner-concurrent-stores/claim-and-hold-child.mjs",
);

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempRoot(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-crash-recovery-"));
  roots.push(root);
  return { root, dbPath: join(root, "portfolio-queue.sqlite3") };
}

function tempStore(dbPath: string) {
  const store = initPortfolioQueueStore(dbPath);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ClaimedEntry = { repoFullName: string; identifier: string; status: string; leasedAt: string };

async function spawnAndWaitForClaim(dbPath: string): Promise<{ child: ChildProcessWithoutNullStreams; claimed: ClaimedEntry }> {
  const child = spawn(process.execPath, [holdChildScript, dbPath], { stdio: ["pipe", "pipe", "pipe"] });
  const claimed = await new Promise<ClaimedEntry>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const line = buffer.split("\n").find((entry) => entry.startsWith("CLAIMED "));
      if (line) {
        child.stdout.off("data", onData);
        resolve(JSON.parse(line.slice("CLAIMED ".length)) as ClaimedEntry);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`child exited before claiming (${code})`));
    });
  });
  return { child, claimed };
}

async function killAndWaitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

describe("portfolio-queue crash recovery (#4868)", () => {
  it("a process killed mid-claim leaves the item stuck in_progress until the lease expires, then it is swept back to queued and re-claimable", async () => {
    const { dbPath } = tempRoot();
    const bootstrap = tempStore(dbPath);
    bootstrap.enqueue({ repoFullName: "acme/widgets", identifier: "pr:1" });

    const { child, claimed } = await spawnAndWaitForClaim(dbPath);
    expect(claimed).toMatchObject({ repoFullName: "acme/widgets", identifier: "pr:1", status: "in_progress" });
    const leasedAtMs = Date.parse(claimed.leasedAt);
    expect(Number.isFinite(leasedAtMs)).toBe(true);

    // Simulate a real crash: SIGKILL, no cleanup handler runs, no markDone/close.
    await killAndWaitForExit(child);

    // The crash alone does not un-stick the row -- it is still genuinely 'in_progress' on disk.
    expect(bootstrap.listInProgress()).toEqual([
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        identifier: "pr:1",
        status: "in_progress",
        leasedAt: claimed.leasedAt,
      },
    ]);

    // Sweeping before the lease bound elapses must NOT reclaim it (still within the grace window).
    const tooSoon = sweepStuckItems(bootstrap, leasedAtMs + 500, 1000);
    expect(tooSoon).toEqual([]);
    expect(bootstrap.listInProgress()).toHaveLength(1);

    // Sweeping once the lease bound has elapsed reclaims the crashed process's item back to 'queued'.
    const reclaimed = sweepStuckItems(bootstrap, leasedAtMs + 1001, 1000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ repoFullName: "acme/widgets", identifier: "pr:1", status: "queued" });
    expect(bootstrap.listInProgress()).toEqual([]);

    // Full recovery: the reclaimed item is claimable again, exactly as if it had never been claimed.
    const reclaimedThenReclaimed = bootstrap.dequeueNext();
    expect(reclaimedThenReclaimed).toMatchObject({ repoFullName: "acme/widgets", identifier: "pr:1", status: "in_progress" });
  });

  it("rejects the claim-and-hold-child helper when required args are missing", async () => {
    const child = spawn(process.execPath, [holdChildScript], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(2);
  });
});
