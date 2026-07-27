#!/usr/bin/env node
// Attested backtest run (#9211, epic #8534) — replay a rule's corpus and capture attestation evidence
// binding WHICH evaluation ran, then persist the outcome.
//
//   npx tsx scripts/attested-backtest-run.ts \
//     --rule-id linked_issue_scope_mismatch --corpus corpus.json \
//     --head-sha <40 hex> --base-sha <40 hex> --repo owner/repo --pr 42 \
//     [--attester sample|snp] [--runtime-claim none|tee] [--measurement <hex>] \
//     [--runtime-class loopover-backtest-runner] [--persist --db loopover [--remote]]
//
// `--attester sample` (default) needs no hardware: it produces a deterministic, self-labeling dev artifact so
// this whole path is exercisable in CI today, with real SNP hardware arriving as `--attester snp` and nothing
// else changing. `--runtime-claim tee` is what makes a missing report FATAL (exit 1) instead of merely
// unattested — set it wherever the workload is supposed to be inside a TEE runtime class (#9213), so a
// misconfigured or lying runtime can never record a run as if attestation had succeeded.
//
// Exit codes: 0 = ran (attested or honestly unattested); 1 = FAIL-CLOSED (a TEE was claimed, evidence was
// not obtained); 2 = unusable input.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Subpath imports, not the engine barrel (#9214): the barrel's `export *` graph is reachable from
// miner/repo-map.ts, which has a top-level `import Parser from "web-tree-sitter"` -- a static import that
// forces web-tree-sitter (and, via its own on-disk resolution at call time, tree-sitter-wasms) onto any
// image that loads the barrel, even though this script never calls into repo-map's functions. The reproducible
// replay-runner image (scripts/replay-runner/Dockerfile) is measured inside an eventual TEE; minimizing what
// it depends on is a real security property (a smaller trusted computing base), not just a size optimization.
// Same rationale + mechanism as src/db/repositories.ts's `@loopover/engine/parse-pull-request-target-key`.
import { assembleAttestationEnvelope, createSampleAttester, type Attester } from "@loopover/engine/calibration/attester";
import type { BacktestCase } from "@loopover/engine/calibration/backtest-corpus";

import { checksumCases } from "./backtest-corpus-export-core";
import {
  attestedRunExitCode,
  buildAttestedRunAuditInsertSql,
  decideAttestedRunOutcome,
  type RuntimeAttestationClaim,
} from "./attested-backtest-run-core";
import { createSnpAttester } from "./snp-attester";

type Args = {
  ruleId: string;
  corpus: string;
  headSha: string;
  baseSha: string;
  repo: string;
  pr: string;
  attester: string;
  runtimeClaim: RuntimeAttestationClaim;
  runtimeClass: string;
  measurement: string;
  persist: boolean;
  db: string;
  remote: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string, fallback = ""): string => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
  };
  const claim = get("--runtime-claim", "none");
  return {
    ruleId: get("--rule-id"),
    corpus: get("--corpus"),
    headSha: get("--head-sha"),
    baseSha: get("--base-sha"),
    repo: get("--repo"),
    pr: get("--pr"),
    attester: get("--attester", "sample"),
    runtimeClaim: claim === "tee" ? "tee" : "none",
    runtimeClass: get("--runtime-class", "loopover-backtest-runner"),
    // Supplied by the deployment that recorded it when the CoCo runtime class was stood up (#9213) — a guest
    // cannot self-report a trustworthy measurement, and the verifier (#9212) checks it against the expected
    // pinned image digest regardless.
    measurement: get("--measurement"),
    persist: argv.includes("--persist"),
    db: get("--db", "loopover"),
    remote: argv.includes("--remote"),
  };
}

/** Resolve the configured attester. The whole point of the seam: this is the ONLY place the two differ. */
export function resolveAttester(args: Pick<Args, "attester" | "measurement">): Attester {
  if (args.attester === "snp") {
    if (!/^[0-9a-f]{32,128}$/.test(args.measurement)) {
      throw new Error("--attester snp requires --measurement (32-128 lowercase hex characters)");
    }
    return createSnpAttester({ measurement: args.measurement, reportBin: process.env["SNP_REPORT_BIN"] ?? null });
  }
  if (args.attester !== "sample") throw new Error(`unknown --attester: ${args.attester}`);
  return createSampleAttester();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  for (const [flag, value] of [
    ["--rule-id", args.ruleId],
    ["--corpus", args.corpus],
    ["--head-sha", args.headSha],
    ["--base-sha", args.baseSha],
    ["--repo", args.repo],
    ["--pr", args.pr],
  ] as const) {
    if (!value) {
      process.stderr.write(`attested-backtest-run: ${flag} is required\n`);
      process.exit(2);
    }
  }

  const manifest = JSON.parse(readFileSync(args.corpus, "utf8")) as { ruleId: string; checksum: string; cases: BacktestCase[] };
  if (manifest.ruleId !== args.ruleId) {
    process.stderr.write(`corpus manifest is for rule ${manifest.ruleId}, not ${args.ruleId}\n`);
    process.exit(2);
  }
  // Verify before attesting: an envelope binding a checksum the cases don't actually produce would be
  // precisely-committed evidence of the wrong thing.
  if (checksumCases(manifest.cases) !== manifest.checksum) {
    process.stderr.write("corpus manifest checksum mismatch — re-export with backtest-corpus-export.ts\n");
    process.exit(2);
  }

  const runId = randomBytes(16).toString("hex");
  const binding = { corpusChecksum: manifest.checksum, headSha: args.headSha, baseSha: args.baseSha, runId };

  let attester: Attester;
  try {
    attester = resolveAttester(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
    return;
  }

  const assembly = await assembleAttestationEnvelope(attester, binding, args.runtimeClass);
  const outcome = decideAttestedRunOutcome({ claim: args.runtimeClaim, attesterKind: attester.kind, assembly });

  if (args.persist) {
    const sql = buildAttestedRunAuditInsertSql({
      id: randomUUID(),
      targetKey: `${args.repo}#${args.pr}`,
      ruleId: args.ruleId,
      outcome,
      corpusChecksum: manifest.checksum,
      headSha: args.headSha,
      baseSha: args.baseSha,
      runId,
      createdAt: new Date().toISOString(),
    });
    const result = spawnSync("npx", ["wrangler", "d1", "execute", args.db, args.remote ? "--remote" : "--local", "--json", "--command", sql], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) {
      process.stderr.write(`persist failed: ${(result.stderr ?? "").trim()}\n`);
      process.exit(2);
    }
  }

  process.stdout.write(`${JSON.stringify({ status: outcome.status, attesterKind: outcome.attesterKind, runId, corpusChecksum: manifest.checksum }, null, 2)}\n`);
  if (outcome.status === "attestation_failed") {
    process.stderr.write(`FAIL-CLOSED: runtime claimed a TEE but produced no valid evidence: ${outcome.reason}\n`);
  }
  process.exit(attestedRunExitCode(outcome));
}

// Only run when invoked directly, so the exported helpers stay importable by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  await main();
}
