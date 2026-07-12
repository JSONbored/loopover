/** Per-tenant forge configuration (#4784). Every field is a string knob defaulting to the github.com value in
 * `DEFAULT_FORGE_CONFIG`; a tenant overrides only what differs for their forge. */
export type ForgeConfig = {
  apiBaseUrl: string;
  apiVersion: string;
  apiVersionHeader: string;
  acceptHeader: string;
  userAgent: string;
  repoPathPrefix: string;
  searchEndpoint: string;
  searchQualifiers: string;
  tokenEnvVar: string;
};

export const DEFAULT_FORGE_CONFIG: Readonly<ForgeConfig>;

export function resolveForgeConfig(overrides?: Partial<ForgeConfig>): ForgeConfig;
