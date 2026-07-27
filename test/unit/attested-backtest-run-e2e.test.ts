import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildBacktestCorpusManifest } from "../../scripts/backtest-corpus-export-core";
import type { BacktestCase } from "../../packages/loopover-engine/src/index";

// End-to-end for the attested-run CLI (#9211), executed as a REAL subprocess against the sample attester --
// which is the whole point of the seam: this exercises the complete path (corpus verify -> bind -> collect ->
// assemble -> classify -> exit code) on ordinary CI hardware, so the only thing real SNP metal changes is the
// `--attester snp` branch. Mirrors the repo's other real-subprocess CLI suites.

const RULE_ID = "linked_issue_scope_mismatch";
const HEAD_SHA = "b2".repeat(20);
const BASE_SHA = "c3".repeat(20);
const CASES: BacktestCase[] = [
  { targetKey: "acme/widgets#1", ruleId: RULE_ID, fired: true, overridden: false } as unknown as BacktestCase,
];

let dir: string;
let corpusPath: string;

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    // tsx, not bare node: the repo's script family uses `.js` specifiers between sibling scripts (the
    // NodeNext convention tsc enforces), which only tsx resolves back to their `.ts` sources -- the same
    // runner .github/workflows/calibration-advisory.yml uses for the sibling backtest CLIs.
    const stdout = execFileSync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [join(process.cwd(), "scripts/attested-backtest-run.ts"), ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const BASE_ARGS = ["--rule-id", RULE_ID, "--head-sha", HEAD_SHA, "--base-sha", BASE_SHA, "--repo", "acme/widgets", "--pr", "42"];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "attested-run-"));
  corpusPath = join(dir, "corpus.json");
  writeFileSync(corpusPath, JSON.stringify(buildBacktestCorpusManifest(RULE_ID, CASES)));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("attested-backtest-run CLI (real subprocess)", () => {
  it("runs the full attested path with the sample attester and exits 0", () => {
    const result = run([...BASE_ARGS, "--corpus", corpusPath]);
    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("attested");
    expect(report.attesterKind).toBe("sample");
    expect(report.corpusChecksum).toMatch(/^[0-9a-f]{64}$/);
    // A fresh freshness token per run is what stops a valid report being replayed for a different run.
    expect(report.runId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("mints a distinct runId on every invocation", () => {
    const first = JSON.parse(run([...BASE_ARGS, "--corpus", corpusPath]).stdout);
    const second = JSON.parse(run([...BASE_ARGS, "--corpus", corpusPath]).stdout);
    expect(first.runId).not.toBe(second.runId);
  });

  it("FAIL-CLOSED: claiming a TEE with no reachable hardware exits 1 and says so", () => {
    // No agent, no report helper, on ordinary CI hardware -- exactly the misconfigured-runtime case.
    const result = run([...BASE_ARGS, "--corpus", corpusPath, "--attester", "snp", "--measurement", "a".repeat(64), "--runtime-claim", "tee"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe("attestation_failed");
    expect(result.stderr).toContain("FAIL-CLOSED");
  });

  it("the SAME failure without a TEE claim is honestly unattested, and exits 0", () => {
    const result = run([...BASE_ARGS, "--corpus", corpusPath, "--attester", "snp", "--measurement", "a".repeat(64)]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("unattested");
  });

  it("rejects a corpus whose cases do not produce its recorded checksum", () => {
    const tampered = join(dir, "tampered.json");
    const manifest = buildBacktestCorpusManifest(RULE_ID, CASES);
    writeFileSync(tampered, JSON.stringify({ ...manifest, checksum: "0".repeat(64) }));

    const result = run([...BASE_ARGS, "--corpus", tampered]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("checksum mismatch");
  });

  it("rejects a corpus exported for a different rule, and a missing required flag", () => {
    const otherRule = join(dir, "other.json");
    writeFileSync(otherRule, JSON.stringify(buildBacktestCorpusManifest("some_other_rule", CASES)));
    const mismatched = run([...BASE_ARGS, "--corpus", otherRule]);
    expect(mismatched.status).toBe(2);
    expect(mismatched.stderr).toContain("is for rule some_other_rule");

    const missing = run(["--rule-id", RULE_ID, "--corpus", corpusPath]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("--head-sha is required");
  });

  it("rejects --attester snp without a usable measurement, and an unknown attester name", () => {
    const noMeasurement = run([...BASE_ARGS, "--corpus", corpusPath, "--attester", "snp"]);
    expect(noMeasurement.status).toBe(2);
    expect(noMeasurement.stderr).toContain("requires --measurement");

    const unknown = run([...BASE_ARGS, "--corpus", corpusPath, "--attester", "nonsense"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown --attester: nonsense");
  });
});
