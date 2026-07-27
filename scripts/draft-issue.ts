#!/usr/bin/env node
// Issue-drafting CLI (#8103, epic #8082) — the FIRST thin consumer of the pure issue-drafting core
// (src/services/issue-drafting.ts): reads the loose prompt, walks the checkout to build the searchable
// corpus, calls the core, and writes the drafted body to a local file for the maintainer to read, edit,
// and only then publish by hand. All grounding/drafting logic lives in the core (unit-tested there); this
// file is the thin IO wrapper — mirrors scripts/export-d1-data.ts's identical role next to
// export-d1-core.ts. NEVER publishes anything, NEVER touches labels/milestones — see the core's own
// boundary comment.
//
//   tsx scripts/draft-issue.ts --prompt "<loose intent>" --output <draft.md> [--root .] [--misses <file.json>]
//   tsx scripts/draft-issue.ts --prompt-file <intent.txt> --output <draft.md> [--root .] [--misses <file.json>]
//
// #8118: every draft automatically applies the accumulated drafting-miss lessons from
// scripts/drafting-misses.json (recorded via scripts/record-drafting-miss.ts) when that file exists;
// --misses points at a different file. A malformed misses file fails the draft loudly — see
// parseDraftingMisses's own fail-loud rationale.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DEFAULT_DRAFTING_MISSES_FILE,
  draftIssueBody,
  parseDraftingMisses,
  type CorpusFile,
  type DraftingMiss,
} from "../src/services/issue-drafting";

type Args = {
  prompt: string | undefined;
  promptFile: string | undefined;
  output: string | undefined;
  root: string;
  misses: string | undefined;
};

// The corpus mirrors where real precedent lives (the gate's own wantedPaths, minus content-free dirs).
const CORPUS_DIRS = ["src", "packages", "scripts", "test", "migrations", ".github/workflows"];
const CORPUS_EXTENSIONS = [".ts", ".tsx", ".sql", ".yml", ".yaml", ".jsonc", ".md"];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".turbo"]);
const MAX_FILE_BYTES = 512 * 1024;

function parseArgs(argv: string[]): Args {
  const args: Args = { prompt: undefined, promptFile: undefined, output: undefined, root: ".", misses: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--prompt") args.prompt = argv[++i];
    else if (flag === "--prompt-file") args.promptFile = argv[++i];
    else if (flag === "--output") args.output = argv[++i];
    else if (flag === "--root") args.root = argv[++i]!;
    else if (flag === "--misses") args.misses = argv[++i];
  }
  return args;
}

// #8118: apply the accumulated misses on EVERY draft — the default file is picked up automatically when it
// exists, so the loop needs no flag to keep working; an explicitly-passed path must exist (a typo silently
// drafting without the checklist would defeat the loop).
function loadDraftingMisses(root: string, explicitPath: string | undefined): DraftingMiss[] {
  const path = explicitPath ?? join(root, DEFAULT_DRAFTING_MISSES_FILE);
  if (!existsSync(path)) {
    if (explicitPath) throw new Error(`--misses file not found: ${explicitPath}`);
    return [];
  }
  return parseDraftingMisses(readFileSync(path, "utf8"));
}

function collectCorpus(root: string): CorpusFile[] {
  const corpus: CorpusFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a listed corpus dir may not exist in a partial checkout -- skip, never crash the draft
    }
    for (const entry of entries.sort()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) walk(fullPath);
      else if (CORPUS_EXTENSIONS.some((extension) => entry.endsWith(extension)) && stats.size <= MAX_FILE_BYTES) {
        corpus.push({ path: relative(root, fullPath), content: readFileSync(fullPath, "utf8") });
      }
    }
  };
  for (const dir of CORPUS_DIRS) walk(join(root, dir));
  return corpus;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt ?? (args.promptFile ? readFileSync(args.promptFile, "utf8") : undefined);
  if (!prompt || !args.output) {
    console.error("Usage: tsx scripts/draft-issue.ts (--prompt <text> | --prompt-file <file>) --output <draft.md> [--root .] [--misses <file.json>]");
    process.exit(2);
  }

  const corpus = collectCorpus(args.root);
  const misses = loadDraftingMisses(args.root, args.misses);
  const result = draftIssueBody(prompt, corpus, { misses });
  writeFileSync(args.output, result.body);
  console.error(
    `drafted from ${corpus.length} corpus file(s): ${result.groundedTerms.length} term(s) grounded, ` +
      `${result.ungroundedTerms.length} UNGROUNDED marker(s) to resolve by hand, ` +
      `${misses.length} recorded miss(es) applied → ${args.output}`,
  );
  console.error("review + edit before publishing — this tool never publishes, and labels/milestone stay your call.");
}

main();
