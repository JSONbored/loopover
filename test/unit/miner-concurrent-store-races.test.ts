import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openClaimLedger } from "../../packages/gittensory-miner/lib/claim-ledger.js";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";

// Real cross-process concurrency coverage for the claim-ledger and portfolio-queue stores (#4867). Only the
// worktree-allocator had a dedicated multi-process collision test before this; claim-ledger/portfolio-queue
// atomicity was previously only exercised per-function (single process). This spawns two real Node child
// processes racing the same on-disk SQLite file and asserts no double-claim/double-dequeue or corrupted state
// results — the store's own atomic UPSERT/UPDATE...RETURNING statements are what's under test, not the
// conflict-resolution logic (who "should" win a race), which is explicitly out of scope per the issue.

const claimChildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/miner-concurrent-stores/claim-child.mjs",
);
const dequeueChildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/miner-concurrent-stores/dequeue-child.mjs",
);

const roots: string[] = [];

function tempRoot(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-concurrent-races-"));
  roots.push(root);
  return { root, dbPath: join(root, "store.sqlite3") };
}

function spawnChild(script: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
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

async function runBarriered<T>(children: ChildProcessWithoutNullStreams[]): Promise<T[]> {
  await Promise.all(children.map((child) => waitForReady(child)));
  for (const child of children) child.stdin.write("go\n");
  return Promise.all(
    children.map(
      (child) =>
        new Promise<T>((resolve, reject) => {
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          child.once("error", reject);
          child.once("exit", () => {
            const line = stdout
              .split("\n")
              .map((entry) => entry.trim())
              .find((entry) => entry.startsWith("{"));
            if (!line) {
              reject(new Error(`child produced no JSON result: ${stdout}`));
              return;
            }
            resolve(JSON.parse(line) as T);
          });
        }),
    ),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ClaimChildResult = {
  ok: boolean;
  claim?: { repoFullName: string; issueNumber: number; status: string };
  message?: string;
};

describe("claim-ledger cross-process races (#4867)", () => {
  it("two processes claiming the SAME issue simultaneously produce exactly one active row, no duplication", async () => {
    const { dbPath } = tempRoot();
    const children = [
      spawnChild(claimChildScript, [dbPath, "acme/widgets", "42"]),
      spawnChild(claimChildScript, [dbPath, "acme/widgets", "42"]),
    ];
    const results = await runBarriered<ClaimChildResult>(children);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.every((result) => result.claim?.status === "active")).toBe(true);

    const ledger = openClaimLedger(dbPath);
    try {
      const rows = ledger.listClaims({ repoFullName: "acme/widgets" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ repoFullName: "acme/widgets", issueNumber: 42, status: "active" });
    } finally {
      ledger.close();
    }
  });

  it("two processes claiming DIFFERENT issues concurrently both succeed with distinct rows", async () => {
    const { dbPath } = tempRoot();
    const children = [
      spawnChild(claimChildScript, [dbPath, "acme/widgets", "1"]),
      spawnChild(claimChildScript, [dbPath, "acme/widgets", "2"]),
    ];
    const results = await runBarriered<ClaimChildResult>(children);

    expect(results.every((result) => result.ok)).toBe(true);
    const issueNumbers = results.map((result) => result.claim?.issueNumber).sort();
    expect(issueNumbers).toEqual([1, 2]);

    const ledger = openClaimLedger(dbPath);
    try {
      expect(ledger.listClaims({ repoFullName: "acme/widgets" })).toHaveLength(2);
    } finally {
      ledger.close();
    }
  });
});

type DequeueChildResult = {
  ok: boolean;
  entry?: { repoFullName: string; identifier: string } | null;
  message?: string;
};

describe("portfolio-queue cross-process races (#4867)", () => {
  it("two processes racing dequeueNext() on a single queued item: exactly one wins, the other gets null", async () => {
    const { dbPath } = tempRoot();
    const bootstrap = initPortfolioQueueStore(dbPath);
    bootstrap.enqueue({ repoFullName: "acme/widgets", identifier: "pr:1" });
    bootstrap.close();

    const children = [spawnChild(dequeueChildScript, [dbPath]), spawnChild(dequeueChildScript, [dbPath])];
    const results = await runBarriered<DequeueChildResult>(children);

    expect(results.every((result) => result.ok)).toBe(true);
    const winners = results.filter((result) => result.entry != null);
    const empties = results.filter((result) => result.entry == null);
    expect(winners).toHaveLength(1);
    expect(empties).toHaveLength(1);
    expect(winners[0]?.entry).toMatchObject({ repoFullName: "acme/widgets", identifier: "pr:1" });

    const store = initPortfolioQueueStore(dbPath);
    try {
      const rows = store.listQueue("acme/widgets");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("in_progress");
    } finally {
      store.close();
    }
  });

  it("N processes racing dequeueNext() over N queued items claim exactly N distinct items, none duplicated", async () => {
    const { dbPath } = tempRoot();
    const bootstrap = initPortfolioQueueStore(dbPath);
    const identifiers = ["pr:1", "pr:2", "pr:3", "pr:4"];
    for (const identifier of identifiers) {
      bootstrap.enqueue({ repoFullName: "acme/widgets", identifier });
    }
    bootstrap.close();

    const children = identifiers.map(() => spawnChild(dequeueChildScript, [dbPath]));
    const results = await runBarriered<DequeueChildResult>(children);

    expect(results.every((result) => result.ok)).toBe(true);
    const claimedIdentifiers = results.map((result) => result.entry?.identifier).filter(Boolean);
    expect(claimedIdentifiers).toHaveLength(identifiers.length);
    expect(new Set(claimedIdentifiers).size).toBe(identifiers.length);

    const store = initPortfolioQueueStore(dbPath);
    try {
      const rows = store.listQueue("acme/widgets");
      expect(rows.every((row) => row.status === "in_progress")).toBe(true);
      expect(rows).toHaveLength(identifiers.length);
    } finally {
      store.close();
    }
  });

  it("rejects the dequeue-child helper when required args are missing", async () => {
    const child = spawn(process.execPath, [dequeueChildScript], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(2);
  });

  it("rejects the claim-child helper when required args are missing", async () => {
    const child = spawn(process.execPath, [claimChildScript], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(2);
  });
});
