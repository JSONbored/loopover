#!/usr/bin/env node
// Cross-process helper for governor-chokepoint-persisted concurrent-race tests (#8856).
// Opens sibling governor-state + ledger handles, waits for a stdin "go" signal, then runs one persisted
// chokepoint evaluation so multiple Node processes contend on the same rate-limit bucket row.
import { evaluateGovernorChokepointGatePersisted } from "../../../packages/loopover-miner/dist/lib/governor-chokepoint-persisted.js";
import { initGovernorLedger } from "../../../packages/loopover-miner/dist/lib/governor-ledger.js";
import { openGovernorState } from "../../../packages/loopover-miner/dist/lib/governor-state.js";

const [dbPath, ledgerPath, nowMsStr] = process.argv.slice(2);
if (!dbPath || !ledgerPath || !nowMsStr) {
  process.stderr.write("usage: chokepoint-child.mjs <dbPath> <ledgerPath> <nowMs>\n");
  process.exit(2);
}

const governorState = openGovernorState(dbPath);
const ledger = initGovernorLedger(ledgerPath);
const policies = {
  global: { open_pr: { limit: 100, windowMs: 60_000 } },
  perRepo: { open_pr: { limit: 100, windowMs: 60_000 } },
  backoffBaseMs: 100,
};
const input = {
  actionClass: "open_pr",
  repoFullName: "acme/widgets",
  nowMs: Number(nowMsStr),
  wouldBeAction: { action: "open_pr", title: "Fix bug" },
  killSwitchGlobal: false,
  killSwitchRepoPaused: false,
  liveModeGlobalOptIn: true,
  liveModeRepoOptIn: "live",
  capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
  convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
  rateLimitPolicies: policies,
};

let started = false;

function runChokepoint() {
  if (started) return;
  started = true;
  try {
    const result = evaluateGovernorChokepointGatePersisted(input, {
      governorState,
      append: (event) => ledger.appendGovernorEvent(event),
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        allowed: result.decision.allowed,
        count: result.rateLimitBuckets.global.open_pr?.count ?? 0,
      })}\n`,
    );
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    process.exit(1);
  } finally {
    governorState.close();
    ledger.close();
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => runChokepoint());
process.stdout.write("READY\n");
