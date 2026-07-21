export function checkNodeVersion(options?: {
  nodeVersion?: string;
  readFile?: () => string;
}): {
  ok: boolean;
  requiredRange: string | undefined;
  nodeVersion?: string;
};
