#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCodeFile, isTestPath as isTestFile } from "@jsonbored/gittensory-engine/signals/test-evidence";

function lineCount(file) {
  const additions = Number(file.additions ?? 0);
  const deletions = Number(file.deletions ?? 0);
  const total = additions + deletions;
  return Number.isFinite(total) && total > 0 ? total : 1;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function estimateFromMetadata(metadata) {
  const changedFiles = Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [];
  let sourceTokenScore = 0;
  let testTokenScore = 0;
  let nonCodeTokenScore = 0;
  let sourceLines = 0;

  for (const file of changedFiles) {
    const path = String(file.path ?? "");
    const lines = lineCount(file);
    if (isTestFile(path)) {
      testTokenScore += lines;
      continue;
    }
    if (isCodeFile(path)) {
      sourceTokenScore += lines;
      sourceLines += lines;
      continue;
    }
    nonCodeTokenScore += lines;
  }

  return {
    sourceTokenScore,
    totalTokenScore: sourceTokenScore + testTokenScore + nonCodeTokenScore,
    sourceLines,
    testTokenScore,
    nonCodeTokenScore,
    warnings: [
      "Reference scorer used metadata line counts only; point GITTENSOR_SCORE_PREVIEW_CMD at scripts/gittensor-score-preview.py with GITTENSOR_ROOT for tree-sitter scoring.",
    ],
  };
}

async function main() {
  const raw = await readStdin();
  const metadata = raw.trim() ? JSON.parse(raw) : {};
  process.stdout.write(`${JSON.stringify(estimateFromMetadata(metadata))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "reference_scorer_failed"}\n`);
  process.exit(1);
});
