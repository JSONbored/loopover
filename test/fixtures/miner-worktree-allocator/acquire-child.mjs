#!/usr/bin/env node
// Cross-process helper for worktree-allocator collision tests (#4298).
// Opens the shared store, waits for a stdin "go" signal, then calls acquire() so
// multiple Node processes contend on BEGIN IMMEDIATE against the same dbPath.
import { openWorktreeAllocator } from "../../../packages/gittensory-miner/lib/worktree-allocator.js";

const [dbPath, worktreeBaseDir, maxConcurrencyStr, attemptId, repoFullName] = process.argv.slice(2);
if (!dbPath || !worktreeBaseDir || !maxConcurrencyStr || !attemptId || !repoFullName) {
  process.stderr.write("usage: acquire-child.mjs <dbPath> <worktreeBaseDir> <maxConcurrency> <attemptId> <repoFullName>\n");
  process.exit(2);
}

const allocator = openWorktreeAllocator({
  dbPath,
  worktreeBaseDir,
  maxConcurrency: Number(maxConcurrencyStr),
});

let started = false;

function runAcquire() {
  if (started) return;
  started = true;
  try {
    const allocation = allocator.acquire(attemptId, repoFullName);
    process.stdout.write(`${JSON.stringify({ ok: true, allocation })}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    process.exit(1);
  } finally {
    allocator.close();
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => runAcquire());
process.stdout.write("READY\n");
