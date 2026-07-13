import { evaluateDenyHooks } from "./deny-hooks.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";

const DENY_CHECK_USAGE =
  "Usage: gittensory-miner hooks check --tool <name> --input <json> [--json]";

function parseToolInput(raw) {
  if (raw === undefined) {
    return { error: "Missing value for --input." };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Tool input must be a JSON object." };
    }
    return { value: parsed };
  } catch {
    return { error: "Tool input must be valid JSON." };
  }
}

export function parseDenyCheckArgs(args) {
  const options = {
    json: false,
    tool: undefined,
    input: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--tool" || token === "--name") {
      const tool = args[++index];
      if (!tool) return { error: "Missing value for --tool." };
      options.tool = tool;
      continue;
    }
    if (token === "--input") {
      const parsed = parseToolInput(args[++index]);
      if ("error" in parsed) return { error: parsed.error };
      options.input = parsed.value;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    return { error: DENY_CHECK_USAGE };
  }

  if (!options.tool || !options.input) {
    return { error: DENY_CHECK_USAGE };
  }

  return options;
}

export function runDenyCheck(args) {
  const parsed = parseDenyCheckArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const verdict = evaluateDenyHooks({ name: parsed.tool, input: parsed.input });
  if (parsed.json) {
    console.log(JSON.stringify(verdict));
  } else if (!verdict.allowed) {
    console.error(verdict.blockedBy?.reason ?? "Blocked by deny hook.");
  } else {
    console.log("allowed");
  }

  return verdict.allowed ? 0 : 1;
}
