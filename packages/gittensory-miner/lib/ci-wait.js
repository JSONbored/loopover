import { pollCheckRuns } from "./ci-poller.js";

const CI_WAIT_USAGE =
  "Usage: gittensory-miner ci wait <owner/repo> <pr-number> [--json] [--max-attempts N] [--min-interval-ms N] [--max-interval-ms N]";

function parsePositiveInt(flag, value) {
  if (value === undefined) {
    return { error: `Missing value for ${flag}.` };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: `Invalid value for ${flag}: must be a positive integer.` };
  }
  return { value: parsed };
}

export function parseCiWaitArgs(args) {
  const positional = [];
  const options = {
    json: false,
    maxAttempts: undefined,
    minIntervalMs: undefined,
    maxIntervalMs: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--max-attempts") {
      const parsed = parsePositiveInt("--max-attempts", args[++index]);
      if ("error" in parsed) return { error: parsed.error };
      options.maxAttempts = parsed.value;
      continue;
    }
    if (token === "--min-interval-ms") {
      const parsed = parsePositiveInt("--min-interval-ms", args[++index]);
      if ("error" in parsed) return { error: parsed.error };
      options.minIntervalMs = parsed.value;
      continue;
    }
    if (token === "--max-interval-ms") {
      const parsed = parsePositiveInt("--max-interval-ms", args[++index]);
      if ("error" in parsed) return { error: parsed.error };
      options.maxIntervalMs = parsed.value;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length !== 2) {
    return { error: CI_WAIT_USAGE };
  }

  const prNumber = Number(positional[1]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { error: "PR number must be a positive integer." };
  }

  return {
    repoFullName: positional[0],
    prNumber,
    ...options,
  };
}

export async function runCiWait(args, input) {
  const parsed = parseCiWaitArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const token = String(
    input.env?.GITTENSOR_MINER_GITHUB_TOKEN ?? input.env?.GITHUB_TOKEN ?? "",
  ).trim();
  if (!token) {
    console.error("Missing GitHub token: set GITHUB_TOKEN or GITTENSOR_MINER_GITHUB_TOKEN.");
    return 2;
  }

  try {
    const result = await pollCheckRuns(parsed.repoFullName, parsed.prNumber, {
      githubToken: token,
      ...(parsed.maxAttempts !== undefined ? { maxAttempts: parsed.maxAttempts } : {}),
      ...(parsed.minIntervalMs !== undefined ? { minIntervalMs: parsed.minIntervalMs } : {}),
      ...(parsed.maxIntervalMs !== undefined ? { maxIntervalMs: parsed.maxIntervalMs } : {}),
    });

    if (parsed.json) {
      console.log(JSON.stringify(result));
    } else {
      const shortSha = result.headSha ? result.headSha.slice(0, 7) : "unknown";
      console.error(
        `CI ${result.conclusion} for ${parsed.repoFullName}#${parsed.prNumber} @ ${shortSha} (${result.attempts} attempt(s))`,
      );
      for (const check of result.checks) {
        console.error(`  ${check.name}: ${check.conclusion}`);
      }
    }

    return result.conclusion === "success" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
