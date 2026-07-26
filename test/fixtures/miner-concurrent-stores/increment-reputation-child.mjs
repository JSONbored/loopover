#!/usr/bin/env node
// Cross-process helper for governor reputation-history concurrent-race tests (#8855).
// Opens the shared governor-state db, waits for a stdin "go" signal, then calls incrementReputationHistory()
// so multiple Node processes contend on the same governor_reputation_history row via the same dbPath.
import { openGovernorState } from "../../../packages/loopover-miner/dist/lib/governor-state.js";

const [dbPath, repoFullName, decidedDeltaStr, unfavorableDeltaStr] = process.argv.slice(2);
if (!dbPath || !repoFullName || !decidedDeltaStr || !unfavorableDeltaStr) {
  process.stderr.write(
    "usage: increment-reputation-child.mjs <dbPath> <repoFullName> <decidedDelta> <unfavorableDelta>\n",
  );
  process.exit(2);
}

const state = openGovernorState(dbPath);
let started = false;

function runIncrement() {
  if (started) return;
  started = true;
  try {
    const history = state.incrementReputationHistory(repoFullName, {
      decided: Number(decidedDeltaStr),
      unfavorable: Number(unfavorableDeltaStr),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, history })}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    process.exit(1);
  } finally {
    state.close();
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => runIncrement());
process.stdout.write("READY\n");
