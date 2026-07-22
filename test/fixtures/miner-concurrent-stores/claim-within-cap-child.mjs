#!/usr/bin/env node
// Cross-process helper for claimIssueWithinCap concurrent-load tests (#4942).
// Opens the shared ledger, waits for a stdin "go" signal, then races
// claimIssueWithinCap so multiple Node processes contend on BEGIN IMMEDIATE +
// the per-repo active-claim cap against the same dbPath.
import { openClaimLedger } from "../../../packages/loopover-miner/lib/claim-ledger.js";

const [dbPath, repoFullName, issueNumberStr, maxConcurrentClaimsStr, note] = process.argv.slice(2);
if (!dbPath || !repoFullName || !issueNumberStr || !maxConcurrentClaimsStr) {
  process.stderr.write(
    "usage: claim-within-cap-child.mjs <dbPath> <repoFullName> <issueNumber> <maxConcurrentClaims> [note]\n",
  );
  process.exit(2);
}

const ledger = openClaimLedger(dbPath);
let started = false;

function runClaim() {
  if (started) return;
  started = true;
  try {
    const result = ledger.claimIssueWithinCap(
      repoFullName,
      Number(issueNumberStr),
      note || null,
      undefined,
      Number(maxConcurrentClaimsStr),
    );
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, message })}\n`);
    process.exit(1);
  } finally {
    ledger.close();
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => runClaim());
process.stdout.write("READY\n");
