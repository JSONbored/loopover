#!/usr/bin/env node
// Cross-process helper for worktree-allocator collision tests (#4298).
// Opens the shared store, waits for a stdin "go" signal, then calls acquire() so
// multiple Node processes contend on BEGIN IMMEDIATE against the same dbPath.
//
// LEASE LIFECYCLE (#8992): a child that acquires successfully HOLDS its lease (process alive, allocator
// open) until the test sends "done". Exiting right after acquire — the previous behavior — violated the
// lease contract the allocator is built around: the same-host dead-pid fast path in every LATER child's
// on-acquire sweep (#8859) then correctly reclaimed the dead child's slot and re-issued the same path,
// which is exactly what the distinct-paths and capacity tests flaked on under CI load (4-of-5, then
// 2-of-5 distinct). Production owners stay alive for the whole worktree lifetime; the fixture now does too.
import { openWorktreeAllocator } from "../../../packages/loopover-miner/dist/lib/worktree-allocator.js";

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
let holdingLease = false;

function runAcquire() {
  if (started) return;
  started = true;
  try {
    const allocation = allocator.acquire(attemptId, repoFullName);
    holdingLease = true;
    process.stdout.write(`${JSON.stringify({ ok: true, allocation })}\n`);
    // Stay alive: the lease is held until the test says "done".
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    allocator.close();
    process.exit(1);
  }
}

function finish() {
  if (!holdingLease) return;
  holdingLease = false;
  allocator.close();
  process.exit(0);
}

process.stdin.setEncoding("utf8");
let stdinBuffer = "";
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  if (stdinBuffer.includes("go\n")) runAcquire();
  if (stdinBuffer.includes("done\n")) finish();
});
process.stdout.write("READY\n");
