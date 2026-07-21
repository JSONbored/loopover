import { fetchContributorPrOutcomes } from "./pr-outcomes-client.js";
import type { FetchContributorPrOutcomesOptions } from "./pr-outcomes-client.js";
export type ParsedPrOutcomesArgs = {
    login: string;
    json: boolean;
    limit?: number;
} | {
    error: string;
};
export type RunPrOutcomesOptions = {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchContributorPrOutcomesOptions["fetchImpl"];
    /** Injectable client fn so tests drive the CLI without a real backend; defaults to the real client. */
    fetchContributorPrOutcomes?: typeof fetchContributorPrOutcomes;
};
/** Parse `--login <login> [--limit <n>] [--json]`. `--login` is required (mirrors attempt-cli's `--login` posture,
 *  since the miner's own login is not stored in the loopover-mcp profile). */
export declare function parsePrOutcomesArgs(args: string[]): ParsedPrOutcomesArgs;
export declare function runPrOutcomes(args: string[], options?: RunPrOutcomesOptions): Promise<number>;
