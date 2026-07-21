/** `pr-outcomes` CLI command (#7658): print the current miner's own post-merge PR-outcome history from the hosted
 * `GET /v1/contributors/:login/pr-outcomes` endpoint. Thin composition layer -- argv parsing plus a call into
 * pr-outcomes-client.js, which owns the session-authed, FAIL-LOUD HTTP surface. Every failure the client throws
 * (no session, unreachable host, non-2xx, malformed body) is reported here as a non-zero exit with the client's own
 * message; there is no silent-degrade path. Merged-PR outcomes only, per the endpoint's current scope. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { fetchContributorPrOutcomes } from "./pr-outcomes-client.js";
const PR_OUTCOMES_USAGE = "Usage: loopover-miner pr-outcomes --login <github-login> [--limit <1-100>] [--json]";
/** Parse `--login <login> [--limit <n>] [--json]`. `--login` is required (mirrors attempt-cli's `--login` posture,
 *  since the miner's own login is not stored in the loopover-mcp profile). */
export function parsePrOutcomesArgs(args) {
    let login = null;
    let limit = null;
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            json = true;
            continue;
        }
        if (token === "--login") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: PR_OUTCOMES_USAGE };
            login = value;
            index += 1;
            continue;
        }
        if (token === "--limit") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: PR_OUTCOMES_USAGE };
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
    if (login === null)
        return { error: PR_OUTCOMES_USAGE };
    return { login, json, ...(limit !== null ? { limit } : {}) };
}
function renderOutcome(outcome) {
    const repo = typeof outcome.repoFullName === "string" ? outcome.repoFullName : "(unknown)";
    const pr = outcome.pullNumber === null || outcome.pullNumber === undefined ? "#?" : `#${outcome.pullNumber}`;
    const recordedAt = typeof outcome.recordedAt === "string" ? outcome.recordedAt : "(unknown)";
    return `${repo} ${pr}  merged  ${recordedAt}`;
}
function renderReport(report) {
    const lines = [typeof report.summary === "string" ? report.summary : `${report.count} merged PR(s).`];
    for (const outcome of report.outcomes)
        lines.push(`- ${renderOutcome(outcome)}`);
    return lines.join("\n");
}
export async function runPrOutcomes(args, options = {}) {
    const parsed = parsePrOutcomesArgs(args);
    if ("error" in parsed)
        return reportCliFailure(argsWantJson(args), parsed.error);
    const fetchOutcomes = options.fetchContributorPrOutcomes ?? fetchContributorPrOutcomes;
    try {
        const report = await fetchOutcomes(parsed.login, {
            ...(options.env !== undefined ? { env: options.env } : {}),
            ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
            ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        });
        if (parsed.json) {
            console.log(JSON.stringify(report, null, 2));
        }
        else {
            console.log(renderReport(report));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItb3V0Y29tZXMtY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHItb3V0Y29tZXMtY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7OzBHQUkwRztBQUMxRyxPQUFPLEVBQUUsWUFBWSxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEYsT0FBTyxFQUFFLDBCQUEwQixFQUFFLE1BQU0seUJBQXlCLENBQUM7QUFHckUsTUFBTSxpQkFBaUIsR0FBRyxxRkFBcUYsQ0FBQztBQVdoSDs4RUFDOEU7QUFDOUUsTUFBTSxVQUFVLG1CQUFtQixDQUFDLElBQWM7SUFDaEQsSUFBSSxLQUFLLEdBQWtCLElBQUksQ0FBQztJQUNoQyxJQUFJLEtBQUssR0FBa0IsSUFBSSxDQUFDO0lBQ2hDLElBQUksSUFBSSxHQUFHLEtBQUssQ0FBQztJQUNqQixLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDcEQsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBRSxDQUFDO1FBQzNCLElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLElBQUksR0FBRyxJQUFJLENBQUM7WUFDWixTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDOUIsSUFBSSxDQUFDLEtBQUssSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztnQkFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLGlCQUFpQixFQUFFLENBQUM7WUFDekUsS0FBSyxHQUFHLEtBQUssQ0FBQztZQUNkLEtBQUssSUFBSSxDQUFDLENBQUM7WUFDWCxTQUFTO1FBQ1gsQ0FBQztRQUNE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