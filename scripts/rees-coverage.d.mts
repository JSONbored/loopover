export type NormalizeLcovSfPathsOptions = {
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
};

export function normalizeLcovSfPaths(lcovPath: string, options?: NormalizeLcovSfPathsOptions): void;
