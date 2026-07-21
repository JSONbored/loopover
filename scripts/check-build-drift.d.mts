export function pathsForPackage(name: string): string[];

export function checkBuildDrift(
  paths: string[],
  options?: { cwd?: string; run?: (paths: string[], cwd: string) => string },
): string;

export function main(argv: string[]): void;
