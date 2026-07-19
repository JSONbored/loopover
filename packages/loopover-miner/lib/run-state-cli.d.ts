import type { RunState } from "./run-state.js";
export type ParsedStateGetArgs = {
    repoFullName: string;
    json: boolean;
    apiBaseUrl: string | undefined;
} | {
    error: string;
};
export type ParsedStateSetArgs = {
    repoFullName: string;
    state: RunState;
    dryRun: boolean;
    json: boolean;
    apiBaseUrl: string | undefined;
} | {
    error: string;
};
export declare function parseStateGetArgs(args: string[]): ParsedStateGetArgs;
export declare function parseStateSetArgs(args: string[]): ParsedStateSetArgs;
export declare function runStateGet(args: string[]): number;
export declare function runStateSet(args: string[]): number;
export declare function runStateCli(subcommand: string | undefined, args: string[]): number;
