export function reportCliFailure(wantsJson: boolean, message: string, exitCode?: number): number;
export function argsWantJson(args: readonly string[]): boolean;
export function describeCliError(error: unknown): string;
