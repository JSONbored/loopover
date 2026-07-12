#!/usr/bin/env node
// Cross-process helper for claim-ledger concurrent-race tests (#4867).
// Opens the shared ledger, waits for a stdin "go" signal, then calls claimIssue() so multiple Node
// processes contend on the same UNIQUE(repo_full_name, issue_number) row via the same dbPath.
import { openClaimLedger } from "../../../packages/gittensory-miner/lib/claim-ledger.js";

const [dbPath, repoFullName, issueNumberStr, note] = process.argv.slice(2);
if (!dbPath || !repoFullName || !issueNumberStr) {
  process.stderr.write("usage: claim-child.mjs <dbPath> <repoFullName> <issueNumber> [note]\n");
  process.exit(2);
}

const ledger = openClaimLedger(dbPath);
let started = false;

function runClaim() {
  if (started) return;
  started = true;
  try {
    const claim = ledger.claimIssue(repoFullName, Number(issueNumberStr), note || null);
    process.stdout.write(`${JSON.stringify({ ok: true, claim })}\n`);
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
