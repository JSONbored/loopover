import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Import .ts so CI's build:miner-before-coverage layout attributes hits under --coverage.all=false.
import { openClaimLedger } from "../../packages/loopover-miner/lib/claim-ledger.ts";

// #4942: cross-process claimIssueWithinCap load — BEGIN IMMEDIATE + per-repo cap, no double-active rows.

const claimWithinCapChildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/miner-concurrent-stores/claim-within-cap-child.mjs",
);

const roots: string[] = [];

function tempRoot(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-shared-store-cap-"));
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

type CapChildResult = {
  ok: boolean;
  result?: { claimed: boolean; activeClaimCount: number; maxConcurrentClaims: number };
  message?: string;
};

describe("claimIssueWithinCap cross-process load (#4942)", () => {
  it("N processes racing cap=1 on distinct issues: exactly one claim wins, no lost/duplicated active rows", async () => {
    const { dbPath } = tempRoot();
    const issues = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const children = issues.map((issue) =>
      spawnChild(claimWithinCapChildScript, [dbPath, "acme/widgets", issue, "1", `note:${issue}`]),
    );
    const results = await runBarriered<CapChildResult>(children);

    expect(results.every((result) => result.ok)).toBe(true);
    const winners = results.filter((result) => result.result?.claimed === true);
    const losers = results.filter((result) => result.result?.claimed === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(issues.length - 1);

    const ledger = openClaimLedger(dbPath);
    try {
      const active = ledger.listActiveClaims("acme/widgets");
      expect(active).toHaveLength(1);
      expect(ledger.listClaims({ repoFullName: "acme/widgets", status: "active" })).toHaveLength(1);
      expect(issues.map(Number)).toContain(active[0]?.issueNumber);
    } finally {
      ledger.close();
    }
  });

  it("rejects the claim-within-cap-child helper when required args are missing", async () => {
    const child = spawn(process.execPath, [claimWithinCapChildScript], { stdio: ["ignore", "pipe", "pipe"] });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(2);
  });
});
