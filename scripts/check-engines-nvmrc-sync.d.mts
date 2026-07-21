export function checkEnginesNvmrcSync(options: {
  root: string;
  readFile?: (root: string, relativePath: string) => string;
  listDir?: (root: string, relativePath: string) => string[];
}): {
  failures: string[];
  nvmrcMajor: number;
  checkedPackages: string[];
};
