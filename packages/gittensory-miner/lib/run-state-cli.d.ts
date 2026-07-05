export type ParsedStateGetArgs =
  | {
      repoFullName: string;
      json: boolean;
    }
  | { error: string };

export type ParsedStateSetArgs =
  | {
      repoFullName: string;
      state: "idle" | "discovering" | "planning" | "preparing";
      json: boolean;
    }
  | { error: string };

export function parseStateGetArgs(args: string[]): ParsedStateGetArgs;

export function parseStateSetArgs(args: string[]): ParsedStateSetArgs;

export function runStateGet(args: string[]): number;

export function runStateSet(args: string[]): number;

export function runStateCli(subcommand: string | undefined, args: string[]): number;
