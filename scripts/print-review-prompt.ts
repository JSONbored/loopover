#!/usr/bin/env node
// Canonical judge-prompt extractor (#8222) — the dual-checkout seam the counterfactual replay workflow
// uses: dynamically import src/services/ai-review.ts from a given checkout root (the PR's head or its
// base, exactly like backtest-logic-check.ts imports detection functions) and print either the canonical
// prompt text or its declared version. Read-only; no env, no network.
//
//   tsx scripts/print-review-prompt.ts --root <checkout-dir> [--version-only]
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let root: string | undefined;
  let versionOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") root = argv[++i];
    else if (argv[i] === "--version-only") versionOnly = true;
  }
  if (!root) {
    console.error("Usage: tsx scripts/print-review-prompt.ts --root <checkout-dir> [--version-only]");
    return 1;
  }
  const moduleUrl = pathToFileURL(resolve(root, "src/services/ai-review.ts")).href;
  const mod = (await import(moduleUrl)) as { REVIEW_PROMPT_VERSION?: string; buildCanonicalJudgePrompt?: () => string };
  if (typeof mod.REVIEW_PROMPT_VERSION !== "string" || typeof mod.buildCanonicalJudgePrompt !== "function") {
    // A base checkout predating #8222 has neither export — print a sentinel so the workflow can treat the
    // base as "unversioned" rather than failing (advisory discipline: never a red check over plumbing).
    console.log(versionOnly ? "unversioned" : "");
    return 0;
  }
  console.log(versionOnly ? mod.REVIEW_PROMPT_VERSION : mod.buildCanonicalJudgePrompt());
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
