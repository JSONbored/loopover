#!/usr/bin/env node
// Cross-process helper for portfolio-queue concurrent-race tests (#4867).
// Opens the shared queue, waits for a stdin "go" signal, then calls dequeueNext() so multiple Node
// processes contend on the same atomic UPDATE...RETURNING claim via the same dbPath.
import { initPortfolioQueueStore } from "../../../packages/gittensory-miner/lib/portfolio-queue.js";

const [dbPath] = process.argv.slice(2);
if (!dbPath) {
  process.stderr.write("usage: dequeue-child.mjs <dbPath>\n");
  process.exit(2);
}

const store = initPortfolioQueueStore(dbPath);
let started = false;

function runDequeue() {
  if (started) return;
  started = true;
  try {
    const entry = store.dequeueNext();
    process.stdout.write(`${JSON.stringify({ ok: true, entry })}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    process.exit(1);
  } finally {
    store.close();
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => runDequeue());
process.stdout.write("READY\n");
