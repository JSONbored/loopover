/** `pr-outcomes` CLI command (#7658): print the current miner's own post-merge PR-outcome history from the hosted
 * `GET /v1/contributors/:login/pr-outcomes` endpoint. Thin composition layer -- argv parsing plus a call into
 * pr-outcomes-client.js, which owns the session-authed, FAIL-LOUD HTTP surface. Every failure the client throws
 * (no session, unreachable host, non-2xx, malformed body) is reported here as a non-zero exit with the client's own
 * message; there is no silent-degrade path. Merged-PR outcomes only, per the endpoint's current scope. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { fetchContributorPrOutcomes } from "./pr-outcomes-client.js";
import type { ContributorPrOutcome, ContributorPrOutcomes, FetchContributorPrOutcomesOptions } from "./pr-outcomes-client.js";

const PR_OUTCOMES_USAGE = "Usage: loopover-miner pr-outcomes --login <github-login> [--limit <1-100>] [--json]";

export type ParsedPrOutcomesArgs = { login: string; json: boolean; limit?: number } | { error: string };

export type RunPrOutcomesOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchContributorPrOutcomesOptions["fetchImpl"];
  /** Injectable client fn so tests drive the CLI without a real backend; defaults to the real client. */
  fetchContributorPrOutcomes?: typeof fetchContributorPrOutcomes;
};

/** Parse `--login <login> [--limit <n>] [--json]`. `--login` is required (mirrors attempt-cli's `--login` posture,
 *  since the miner's own login is not stored in the loopover-mcp profile). */
export function parsePrOutcomesArgs(args: string[]): ParsedPrOutcomesArgs {
  let login: string | null = null;
  let limit: number | null = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--login") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: PR_OUTCOMES_USAGE };
      login = value;
      index += 1;
      continue;
    }
    if (token === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: PR_OUTCOMES_USAGE };
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return { error: "pr-outcomes limit must be an integer between 1 and 100" };
      }
      limit = parsed;
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${token}` };
  }
  if (login === null) return { error: PR_OUTCOMES_USAGE };
  return { login, json, ...(limit !== null ? { limit } : {}) };
}

function renderOutcome(outcome: ContributorPrOutcome): string {
  const repo = typeof outcome.repoFullName === "string" ? outcome.repoFullName : "(unknown)";
  const pr = outcome.pullNumber === null || outcome.pullNumber === undefined ? "#?" : `#${outcome.pullNumber}`;
  const recordedAt = typeof outcome.recordedAt === "string" ? outcome.recordedAt : "(unknown)";
  return `${repo} ${pr}  merged  ${recordedAt}`;
}

function renderReport(report: ContributorPrOutcomes): string {
  const lines = [typeof report.summary === "string" ? report.summary : `${report.count} merged PR(s).`];
  for (const outcome of report.outcomes) lines.push(`- ${renderOutcome(outcome)}`);
  return lines.join("\n");
}

export async function runPrOutcomes(args: string[], options: RunPrOutcomesOptions = {}): Promise<number> {
  const parsed = parsePrOutcomesArgs(args);
  if ("error" in parsed) return reportCliFailure(argsWantJson(args), parsed.error);
  const fetchOutcomes = options.fetchContributorPrOutcomes ?? fetchContributorPrOutcomes;
  try {
    const report = await fetchOutcomes(parsed.login, {
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    });
    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReport(report));
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}
