export type ParsedDenyCheckArgs =
  | {
      tool: string;
      input: Record<string, unknown>;
      json: boolean;
    }
  | { error: string };

export function parseDenyCheckArgs(args: string[]): ParsedDenyCheckArgs;

export function runDenyCheck(args: string[]): number;
