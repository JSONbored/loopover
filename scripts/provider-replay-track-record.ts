#!/usr/bin/env node
// Replay-derived provider track records (#8278, seeding #8229 stage 1). Reads the counterfactual replay
// harness's cached raw outputs (the #8221 artifacts dir) for one or more variants over the SAME seeded
// fixture sample, maps each parsed verdict onto the consensus vote vocabulary, and aggregates with
// `computeProviderTrackRecords` (#8228) — the identical function live votes will feed, zero new math.
// REPLAY-DERIVED, NEVER LIVE: signals exist only in this offline report; nothing is written to any store
// and nothing masquerades as a live reviewer_vote event (the #8278 segregation requirement).
//
//   tsx scripts/provider-replay-track-record.ts --fixtures corpus.json --artifacts dir \
//     --variant <promptVersion@modelSpec> [--variant …] [--seed-suffix s] [--max-fixtures N]
//
// Verdict → vote mapping: would_flag ⇒ "fail" (the defect-flagging vote), would_not_flag ⇒ "pass",
// abstained ⇒ NO signal (an abstention is not a vote — the same never-coerced discipline as scoring).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeProviderTrackRecords,
  COUNTERFACTUAL_SAMPLE_SEED_PREFIX,
  type BacktestCase,
  type CounterfactualVariant,
  type ProviderReviewSignal,
  type ProviderTrackRecord,
} from "@loopover/engine";
import { artifactKey, parseVariantVerdict, planReplay, type CounterfactualReplayPlan } from "./counterfactual-replay-core.js";

/** PURE: map one variant's cached raw outputs onto provider signals over the shared plan. The provider id
 *  is the variant's modelSpec (the reviewer identity live votes carry); abstentions and uncached fixtures
 *  yield no signal, counted separately so the report can say how much of the sample actually voted. */
export function artifactsToProviderSignals(
  plan: CounterfactualReplayPlan,
  variant: CounterfactualVariant,
  readArtifact: (key: string) => string | null,
): { signals: ProviderReviewSignal[]; abstained: number; uncached: number } {
  const signals: ProviderReviewSignal[] = [];
  let abstained = 0;
  let uncached = 0;
  for (const fixture of plan.fixtures) {
    const raw = readArtifact(artifactKey(variant, fixture.fixtureId));
    if (raw === null) {
      uncached += 1;
      continue;
    }
    const verdict = parseVariantVerdict(raw);
    if (verdict === "abstained") {
      abstained += 1;
      continue;
    }
    signals.push({
      provider: variant.modelSpec,
      repoFullName: fixture.fixtureId.split("#")[0] ?? fixture.fixtureId,
      targetKey: fixture.fixtureId,
      vote: verdict === "would_flag" ? "fail" : "pass",
    });
  }
  return { signals, abstained, uncached };
}

/** Render the overall-rollup rows (repoFullName null) as the markdown table #8229's stage-1 comment quotes. */
export function renderProviderTable(records: readonly ProviderTrackRecord[]): string {
  const overall = records.filter((record) => record.repoFullName === null);
  const lines = [
    "| Provider | Signals | Decided | Precision (fail⇒confirmed) | Agreement | Consensus |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const fmt = (value: number | null): string => (value === null ? "n/a" : value.toFixed(3));
  for (const record of overall) {
    lines.push(
      `| ${record.provider} | ${record.signals} | ${record.decided} | ${fmt(record.precision)} | ${fmt(record.agreementRate)} | ${fmt(record.consensusRate)} |`,
    );
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): { fixtures: string | undefined; artifacts: string; variants: string[]; seedSuffix: string; maxFixtures: number } {
  const args = { fixtures: undefined as string | undefined, artifacts: ".counterfactual-artifacts", variants: [] as string[], seedSuffix: "default", maxFixtures: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--fixtures") args.fixtures = argv[++i];
    else if (flag === "--artifacts") args.artifacts = argv[++i] ?? args.artifacts;
    else if (flag === "--variant") args.variants.push(argv[++i] ?? "");
    else if (flag === "--seed-suffix") args.seedSuffix = argv[++i] ?? "default";
    else if (flag === "--max-fixtures") args.maxFixtures = Number(argv[++i]);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixtures || args.variants.length === 0 || args.variants.some((variant) => !variant.includes("@"))) {
    console.error("Usage: tsx scripts/provider-replay-track-record.ts --fixtures <corpus.json> --artifacts <dir> --variant <promptVersion@modelSpec> [--variant …]");
    return 1;
  }
  const manifest = JSON.parse(readFileSync(args.fixtures, "utf8")) as { cases?: BacktestCase[] };
  if (!Array.isArray(manifest.cases)) {
    console.error("--fixtures file has no cases[] — expected a backtest-corpus-export manifest.");
    return 1;
  }
  const plan = planReplay(manifest.cases, { seed: `${COUNTERFACTUAL_SAMPLE_SEED_PREFIX}:${args.seedSuffix}`, maxFixtures: args.maxFixtures });

  const allSignals: ProviderReviewSignal[] = [];
  for (const raw of args.variants) {
    const [promptVersion, ...modelParts] = raw.split("@");
    const variant: CounterfactualVariant = { promptVersion: promptVersion!, modelSpec: modelParts.join("@") };
    const { signals, abstained, uncached } = artifactsToProviderSignals(plan, variant, (key) => {
      const path = join(args.artifacts, `${key}.txt`);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    });
    console.log(`${raw}: ${signals.length} signal(s), ${abstained} abstained, ${uncached} uncached (of ${plan.fixtures.length} planned)`);
    allSignals.push(...signals);
  }

  console.log("");
  console.log(renderProviderTable(computeProviderTrackRecords(allSignals, manifest.cases)));
  console.log("\nREPLAY-DERIVED (offline #8221 artifacts) — not live reviewer votes; nothing was persisted.");
  return 0;
}

// Entry guard (the audit-quality-gate-min-score.ts idiom): tests import this module's exported helpers,
// so main() must run ONLY under direct execution — an import-time process.exit fails the whole vitest run
// as an unhandled rejection even with every test green.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
