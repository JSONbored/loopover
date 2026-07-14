import {
  classifyMcpClientVersion,
  GITTENSORY_MCP_PACKAGE_NAME,
  LATEST_RECOMMENDED_MCP_VERSION,
  MINIMUM_SUPPORTED_MCP_VERSION,
  type McpCompatibilityStatus,
} from "./mcp-compatibility";

type ClientTelemetryOptions = {
  requireGittensoryHeader?: boolean;
  defaultClientName?: string;
};

export type McpClientTelemetry = {
  clientName: string;
  clientVersion?: string | undefined;
  metadata: {
    packageName?: string | undefined;
    packageVersion?: string | undefined;
    clientName?: string | undefined;
    protocolVersion?: string | undefined;
    compatibilityStatus: McpCompatibilityStatus;
    minimumSupportedVersion: string;
    latestRecommendedVersion: string;
  };
};

export function buildMcpClientTelemetry(headers: Headers, options: ClientTelemetryOptions = {}): McpClientTelemetry | null {
  const packageName = safePackageHeader(headers.get("x-loopover-mcp-package"));
  const packageVersion = safeVersionHeader(headers.get("x-loopover-mcp-version"));
  const explicitClientName = safeClientHeader(headers.get("x-loopover-mcp-client"));
  const explicitClientVersion = safeVersionHeader(headers.get("x-loopover-mcp-client-version"));
  const protocolVersion = safeProtocolHeader(headers.get("mcp-protocol-version"));
  const hasGittensoryHeader = Boolean(packageName ?? packageVersion ?? explicitClientName ?? explicitClientVersion);
  if (options.requireGittensoryHeader && !hasGittensoryHeader) return null;

  const clientVersion = packageVersion ?? explicitClientVersion;
  const clientName = explicitClientName ?? clientNameFromPackage(packageName) ?? options.defaultClientName ?? "mcp";
  return {
    clientName,
    clientVersion,
    metadata: {
      packageName,
      packageVersion,
      clientName,
      protocolVersion,
      compatibilityStatus: classifyMcpClientVersion(clientVersion),
      minimumSupportedVersion: MINIMUM_SUPPORTED_MCP_VERSION,
      latestRecommendedVersion: LATEST_RECOMMENDED_MCP_VERSION,
    },
  };
}

function clientNameFromPackage(packageName: string | undefined): string | undefined {
  if (!packageName) return undefined;
  if (packageName === GITTENSORY_MCP_PACKAGE_NAME) return "loopover-mcp";
  const tail = packageName.split("/").at(-1);
  return safeClientHeader(tail);
}

function safePackageHeader(value: string | null): string | undefined {
  return safeHeader(value, /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
}

function safeClientHeader(value: string | null | undefined): string | undefined {
  return safeHeader(value ?? null, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
}

function safeVersionHeader(value: string | null): string | undefined {
  return safeHeader(value, /^v?[0-9][0-9A-Za-z.+-]{0,79}$/);
}

function safeProtocolHeader(value: string | null): string | undefined {
  return safeHeader(value, /^[0-9A-Za-z][0-9A-Za-z._+-]{0,79}$/);
}

function safeHeader(value: string | null, pattern: RegExp): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 80) return undefined;
  return pattern.test(trimmed) ? trimmed : undefined;
}
