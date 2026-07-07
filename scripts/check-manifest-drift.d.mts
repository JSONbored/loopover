export function checkManifestDrift(options: {
  root: string;
  readFile?: (root: string, relativePath: string) => string;
  bundledYaml?: string;
}): {
  failures: string[];
  rootManifest: unknown;
  bundledManifest: unknown;
};
