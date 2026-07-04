import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computePairwiseCalibrationScore } from "@jsonbored/gittensory-engine";

const PAIRWISE_SCORE_USAGE =
  "Usage: gittensory-miner calibration pairwise score --input <json|@file> [--json]";

function readJsonFileArg(filePath, label) {
  const trimmed = filePath.trim();
  if (!trimmed) return { error: `${label} file path must not be empty.` };
  if (trimmed.split(/[/\\]/).some((segment) => segment === "..")) {
    return { error: `${label} file path must not contain .. segments.` };
  }
  try {
    return { value: readFileSync(resolve(trimmed), "utf8") };
  } catch {
    return { error: `${label} could not read file: ${trimmed}` };
  }
}

function parseJsonInput(value, label) {
  if (value === undefined || value === null || value === "") {
    return { error: `Missing value for ${label}.` };
  }
  const raw = String(value);
  if (raw.startsWith("@")) {
    const file = readJsonFileArg(raw.slice(1), label);
    if ("error" in file) return file;
    try {
      return { value: JSON.parse(file.value) };
    } catch {
      return { error: `${label} must be valid JSON.` };
    }
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: `${label} must be valid JSON.` };
  }
}

export function parsePairwiseScoreArgs(args) {
  const options = { json: false, input: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--input") {
      const parsed = parseJsonInput(args[index + 1], "--input");
      if ("error" in parsed) return { error: parsed.error };
      options.input = parsed.value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: PAIRWISE_SCORE_USAGE };
  if (!options.input || typeof options.input !== "object" || Array.isArray(options.input)) {
    return { error: PAIRWISE_SCORE_USAGE };
  }
  if (!Array.isArray(options.input.samples)) {
    return { error: "Pairwise calibration input must include a samples array." };
  }
  return options;
}

export function renderPairwiseScoreTable(result) {
  const lines = [
    `composite score: ${result.compositeScore}`,
    `objective anchor: ${result.objectiveAnchorScore}`,
    `pairwise judge: ${result.pairwiseJudgeScore ?? "unavailable"}`,
    `stable samples: ${result.metrics.stableSamples}/${result.metrics.totalSamples}`,
    `order instability: ${result.metrics.orderInstabilityRate}`,
  ];
  return lines.join("\n");
}

export function runPairwiseScore(args, options = {}) {
  const parsed = parsePairwiseScoreArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const compute =
    options.computePairwiseCalibrationScore ?? computePairwiseCalibrationScore;
  try {
    const result = compute({
      objectiveAnchor: parsed.input.objectiveAnchor ?? 0,
      samples: parsed.input.samples,
      weights: parsed.input.weights,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderPairwiseScoreTable(result));
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runCalibrationCli(subcommand, nested, args, options = {}) {
  if (subcommand === "pairwise" && nested === "score") {
    return runPairwiseScore(args, options);
  }
  console.error(
    `Unknown calibration subcommand: ${[subcommand, nested].filter(Boolean).join(" ")}. ${PAIRWISE_SCORE_USAGE}`,
  );
  return 2;
}
