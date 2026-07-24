#!/usr/bin/env node
// Counterfactual replay harness CLI (#8221, sub-epic #8218). Replays a judge variant (prompt version +
// model spec) against the replayable fixture set assembled from a backtest-corpus manifest
// (backtest-corpus-export.ts's output), scores it per the #8219 contract, and — with --baseline —
// prints the Pareto-floored comparison via the shared renderer. All mapping/aggregation logic lives in
// counterfactual-replay-core.ts (unit-tested); this wrapper owns provider IO, the artifacts cache, and
// file reads. OFFLINE-ONLY guarantees (#8219 contract point 2): never posts anywhere, never touches live
// reviews. Local ollama is the smoke path; `--provider workers-ai` (#8279) is the explicitly-flagged
// hosted option for CI — credentials from CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN, refused loudly when
// absent. Every other provider remains unwired by design.
//
//   tsx scripts/counterfactual-replay.ts --fixtures corpus.json --variant <promptVersion@modelSpec>
//        [--budget N] [--max-fixtures N] [--seed-suffix s] [--baseline scores.json] [--out scores.json]
//        [--artifacts dir] [--ollama-url http://localhost:11434] [--prompt-file file.txt]
//
// Exit code reflects OPERATIONAL success only — never a verdict (the #8138 advisory guarantee). A run that
// exhausts its budget mid-set persists partial scores + a resume cursor and still exits 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COUNTERFACTUAL_DEFAULT_NEURON_BUDGET,
  COUNTERFACTUAL_SAMPLE_SEED_PREFIX,
  renderBacktestScoreReport,
  renderBacktestComparison,
  type BacktestCase,
  type BacktestScoreReport,
  type CounterfactualVariant,
  type CounterfactualVerdict,
} from "@loopover/engine";
import { spawnSync } from "node:child_process";
import {
  artifactKey,
  buildCounterfactualAuditInsertSql,
  extractWorkersAiResponse,
  compareReplays,
  estimateFixtureNeurons,
  isRunAccountingValid,
  parseVariantVerdict,
  planReplay,
  renderCounterfactualComment,
} from "./counterfactual-replay-core.js";

type Args = {
  fixtures: string | undefined;
  variant: string | undefined;
  budget: number;
  maxFixtures: number;
  seedSuffix: string;
  baseline: string | undefined;
  out: string | undefined;
  artifacts: string;
  ollamaUrl: string;
  provider: "ollama" | "workers-ai";
  promptFile: string | undefined;
  // #8222 CI mode: emit the marker comment and/or persist the run event (wrangler d1, like #8139).
  commentOut: string | undefined;
  baseVariantLabel: string | undefined;
  headSha: string;
  baseSha: string;
  persist: boolean;
  repo: string | undefined;
  pr: string | undefined;
  db: string;
  remote: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fixtures: undefined,
    variant: undefined,
    budget: COUNTERFACTUAL_DEFAULT_NEURON_BUDGET,
    maxFixtures: 500,
    seedSuffix: "default",
    baseline: undefined,
    out: undefined,
    artifacts: ".counterfactual-artifacts",
    ollamaUrl: "http://localhost:11434",
    provider: "ollama",
    promptFile: undefined,
    commentOut: undefined,
    baseVariantLabel: undefined,
    headSha: "",
    baseSha: "",
    persist: false,
    repo: undefined,
    pr: undefined,
    db: "loopover",
    remote: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--fixtures") args.fixtures = argv[++i];
    else if (flag === "--variant") args.variant = argv[++i];
    else if (flag === "--budget") args.budget = Number(argv[++i]);
    else if (flag === "--max-fixtures") args.maxFixtures = Number(argv[++i]);
    else if (flag === "--seed-suffix") args.seedSuffix = argv[++i] ?? "default";
    else if (flag === "--baseline") args.baseline = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--artifacts") args.artifacts = argv[++i] ?? args.artifacts;
    else if (flag === "--ollama-url") args.ollamaUrl = argv[++i] ?? args.ollamaUrl;
    else if (flag === "--provider") args.provider = (argv[++i] as "ollama" | "workers-ai") ?? "ollama";
    else if (flag === "--prompt-file") args.promptFile = argv[++i];
    else if (flag === "--comment-out") args.commentOut = argv[++i];
    else if (flag === "--base-variant-label") args.baseVariantLabel = argv[++i];
    else if (flag === "--head-sha") args.headSha = argv[++i] ?? "";
    else if (flag === "--base-sha") args.baseSha = argv[++i] ?? "";
    else if (flag === "--persist") args.persist = true;
    else if (flag === "--repo") args.repo = argv[++i];
    else if (flag === "--pr") args.pr = argv[++i];
    else if (flag === "--db") args.db = argv[++i] ?? "loopover";
    else if (flag === "--remote") args.remote = true;
  }
  return args;
}

// The default judge prompt: the minimal would-flag question, JSON-only output so parseVariantVerdict's
// abstention accounting stays honest. A --prompt-file replaces it wholesale (that IS the variant surface
// #8222 will diff), and the prompt text is recorded in the artifacts dir alongside the outputs.
const DEFAULT_JUDGE_PROMPT = [
  "You are a strict senior code reviewer. Below is a unified diff from a pull request that a review gate",
  "previously judged. Decide whether the diff contains a defect serious enough to block a merge.",
  'Respond with ONLY a JSON object: {"blockers": [..strings, empty if none..], "confidence": 0..1}.',
].join("\n");

// Workers AI REST (#8279): the same account already running production reviews. Non-streaming text run;
// a non-OK status throws (operational failure — the campaign stops loudly, never silently mis-scores).
async function judgeWithWorkersAi(accountId: string, token: string, model: string, prompt: string, diff: string): Promise<string> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: `${prompt}\n\n--- DIFF ---\n${diff}` }], temperature: 0 }),
  });
  if (!response.ok) throw new Error(`workers-ai ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return extractWorkersAiResponse(await response.json());
}

async function judgeWithOllama(ollamaUrl: string, model: string, prompt: string, diff: string): Promise<string> {
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: `${prompt}\n\n--- DIFF ---\n${diff}`, stream: false, options: { temperature: 0 } }),
  });
  if (!response.ok) throw new Error(`ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { response?: unknown };
  return typeof body.response === "string" ? body.response : "";
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixtures || !args.variant || !args.variant.includes("@")) {
    console.error("Usage: tsx scripts/counterfactual-replay.ts --fixtures <corpus.json> --variant <promptVersion@modelSpec> [...]");
    return 1;
  }
  if (!Number.isFinite(args.budget) || args.budget <= 0 || !Number.isInteger(args.maxFixtures) || args.maxFixtures <= 0) {
    console.error("--budget and --max-fixtures must be positive.");
    return 1;
  }
  const [promptVersion, ...modelParts] = args.variant.split("@");
  const variant: CounterfactualVariant = { promptVersion: promptVersion!, modelSpec: modelParts.join("@") };
  if (!variant.promptVersion || !variant.modelSpec) {
    console.error("--variant must be <promptVersion@modelSpec>.");
    return 1;
  }

  const manifest = JSON.parse(readFileSync(args.fixtures, "utf8")) as { cases?: BacktestCase[] };
  if (!Array.isArray(manifest.cases)) {
    console.error(`--fixtures file has no cases[] — expected a backtest-corpus-export manifest.`);
    return 1;
  }
  const sampling = { seed: `${COUNTERFACTUAL_SAMPLE_SEED_PREFIX}:${args.seedSuffix}`, maxFixtures: args.maxFixtures };
  const plan = planReplay(manifest.cases, sampling);
  if (plan.fixtures.length === 0) {
    console.log("No replayable fixtures (every case lacked bounded raw context). Nothing to run.");
    return 0;
  }

  // #8279: hosted-provider credentials resolve ONCE, loudly, before any spend.
  let workersAi: { accountId: string; token: string } | null = null;
  if (args.provider === "workers-ai") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId || !token) {
      console.error("--provider workers-ai requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with Workers AI read/run).");
      return 1;
    }
    workersAi = { accountId, token };
  }

  mkdirSync(args.artifacts, { recursive: true });
  const prompt = args.promptFile ? readFileSync(args.promptFile, "utf8") : DEFAULT_JUDGE_PROMPT;
  writeFileSync(join(args.artifacts, `prompt-${variant.promptVersion}.txt`), prompt);

  const { scoreReplay } = await import("./counterfactual-replay-core.js");
  const verdicts = new Map<string, CounterfactualVerdict>();
  let neuronsSpent = 0;
  for (const fixture of plan.fixtures) {
    const cost = estimateFixtureNeurons(fixture, prompt.length);
    if (neuronsSpent + cost > args.budget) break; // budget exhausted: partial run + cursor, by design
    const cachePath = join(args.artifacts, `${artifactKey(variant, fixture.fixtureId)}.txt`);
    let raw: string;
    if (existsSync(cachePath)) {
      raw = readFileSync(cachePath, "utf8"); // cached raw output: re-scoring is free
    } else {
      raw = workersAi
        ? await judgeWithWorkersAi(workersAi.accountId, workersAi.token, variant.modelSpec, prompt, fixture.boundedInputs.diff)
        : await judgeWithOllama(args.ollamaUrl, variant.modelSpec, prompt, fixture.boundedInputs.diff);
      writeFileSync(cachePath, raw);
      neuronsSpent += cost; // cache hits spend nothing — only real provider calls count
    }
    verdicts.set(fixture.fixtureId, parseVariantVerdict(raw));
  }

  const scored = scoreReplay(plan, variant, sampling, verdicts, neuronsSpent);
  if (!isRunAccountingValid(plan, scored.summary)) {
    console.error("run accounting invariant violated — refusing to persist a summary that does not sum to the fixture universe.");
    return 1;
  }

  console.log(renderBacktestScoreReport(scored.report));
  console.log(
    `scored ${scored.summary.scored} | abstained ${scored.summary.abstained} | skipped no_raw_context ${scored.summary.skipped.no_raw_context}, sampled_out ${scored.summary.skipped.sampled_out} | neurons ${scored.summary.neuronsSpent}/${args.budget}` +
      (scored.summary.resumeFrom ? ` | resume from ${scored.summary.resumeFrom}` : ""),
  );

  if (args.out) writeFileSync(args.out, `${JSON.stringify({ report: scored.report, summary: scored.summary }, null, 2)}\n`);

  if (args.baseline) {
    const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as {
      report?: BacktestScoreReport;
      summary?: { abstained?: number; variant?: { promptVersion?: string } };
    };
    if (!baseline.report) {
      console.error("--baseline file has no report — expected a prior --out artifact.");
      return 1;
    }
    const comparison = compareReplays(baseline.report, scored.report);
    console.log(renderBacktestComparison(comparison));

    // #8222 CI mode: the marker comment + the persisted run event, mirroring backtest-logic-check.ts.
    if (args.commentOut) {
      writeFileSync(
        args.commentOut,
        renderCounterfactualComment(comparison, {
          promptVersionBase: args.baseVariantLabel ?? baseline.summary?.variant?.promptVersion ?? "base",
          promptVersionHead: variant.promptVersion,
          modelSpec: variant.modelSpec,
          headSha: args.headSha,
          baseSha: args.baseSha,
          scored: scored.summary.scored,
          abstainedBase: baseline.summary?.abstained ?? 0,
          abstainedHead: scored.summary.abstained,
          skippedNoRawContext: scored.summary.skipped.no_raw_context,
          sampledOut: scored.summary.skipped.sampled_out,
          seed: sampling.seed,
        }),
      );
    }
    if (args.persist) {
      if (!args.repo || !args.pr) {
        console.error("--persist requires --repo and --pr.");
        return 1;
      }
      const sql = buildCounterfactualAuditInsertSql({
        id: crypto.randomUUID(),
        targetKey: `${args.repo}#${args.pr}`,
        comparison,
        headSha: args.headSha,
        baseSha: args.baseSha,
        promptVersionBase: args.baseVariantLabel ?? baseline.summary?.variant?.promptVersion ?? "base",
        promptVersionHead: variant.promptVersion,
        modelSpec: variant.modelSpec,
        scored: scored.summary.scored,
        createdAt: new Date().toISOString(),
      });
      const result = spawnSync("npx", ["wrangler", "d1", "execute", args.db, args.remote ? "--remote" : "--local", "--json", "--command", sql], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      if (result.status !== 0) {
        console.error(`persist failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 400)}`);
        return 1;
      }
      console.log("run persisted (calibration.counterfactual_backtest_run).");
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
