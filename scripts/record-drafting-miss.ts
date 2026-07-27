#!/usr/bin/env node
// Drafting-miss recorder (#8118, extends #8103) — the cheap, MANUAL way the maintainer flags a real
// post-merge gap traceable to a drafted issue: something the draft should have specified but didn't.
// Appends one validated record to the shared misses file (scripts/drafting-misses.json by default);
// scripts/draft-issue.ts reads that file on every subsequent draft and renders the accumulated lessons as
// a pre-publish checklist. Nothing here auto-detects gaps — a human decides what counts as a miss, this
// just captures it once found. Thin IO wrapper; the validation lives in the core's parseDraftingMisses.
//
//   tsx scripts/record-drafting-miss.ts --prompt "<the loose prompt used>" --missing "<the reusable lesson>" \
//     [--category <gap-category>] [--file scripts/drafting-misses.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_DRAFTING_MISSES_FILE, parseDraftingMisses, type DraftingMiss } from "../src/services/issue-drafting";

type Args = {
  prompt: string | undefined;
  missing: string | undefined;
  category: string | undefined;
  file: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { prompt: undefined, missing: undefined, category: undefined, file: DEFAULT_DRAFTING_MISSES_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--prompt") args.prompt = argv[++i];
    else if (flag === "--missing") args.missing = argv[++i];
    else if (flag === "--category") args.category = argv[++i];
    else if (flag === "--file") args.file = argv[++i]!;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt || !args.missing) {
    console.error(
      'Usage: tsx scripts/record-drafting-miss.ts --prompt "<loose prompt>" --missing "<lesson>" [--category <gap-category>] [--file scripts/drafting-misses.json]',
    );
    process.exit(2);
  }

  // Re-validate the whole file through the core parser on every append, so a hand-edit that broke it is
  // caught here (at record time) instead of failing the next draft.
  const existing: DraftingMiss[] = existsSync(args.file) ? parseDraftingMisses(readFileSync(args.file, "utf8")) : [];
  const miss: DraftingMiss = {
    recordedAt: new Date().toISOString(),
    loosePrompt: args.prompt,
    missing: args.missing,
    ...(args.category ? { category: args.category } : {}),
  };
  existing.push(miss);
  writeFileSync(args.file, `${JSON.stringify(existing, null, 2)}\n`);
  console.error(`recorded drafting miss #${existing.length}${args.category ? ` [${args.category}]` : ""} → ${args.file}`);
}

main();
