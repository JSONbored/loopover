import type { GovernorState } from "./governor-state.js";
export type ParsedGovernorPauseArgs = {
    json: boolean;
    dryRun: boolean;
    reason: string | null;
} | {
    error: string;
};
export type ParsedGovernorResumeArgs = {
    json: boolean;
    dryRun: boolean;
} | {
    error: string;
};
export type ParsedGovernorNoArgsSubcommand = {
    json: boolean;
} | {
    error: string;
};
export type GovernorPauseCliOptions = {
    openGovernorState?: () => GovernorState;
};
export declare function parseGovernorPauseArgs(args: string[]): ParsedGovernorPauseArgs;
export declare function parseGovernorResumeArgs(args: string[]): ParsedGovernorResumeArgs;
export declare function runGovernorPause(args: string[], options?: GovernorPauseCliOptions): Promise<number>;
export declare function runGovernorResume(args: string[], options?: GovernorPauseCliOptions): Promise<number>;
export declare function runGovernorStatus(args: string[], options?: GovernorPauseCliOptions): Promise<number>;
