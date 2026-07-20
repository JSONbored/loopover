// Resolve the real client IP for self-host rate limiting (#477).
export function resolveTrustedClientIp(
  peerAddress: string | undefined,
  headers: Headers,
): string {
  const peer = normalizeIpAddress(stripIpv4MappedPrefix(peerAddress));
  const xReal = normalizeIpAddress(headers.get("x-real-ip") ?? undefined);
  const xff = normalizeIpAddress(headers.get("x-forwarded-for")?.split(",")[0]?.trim());

  if (peer && isPrivateOrLinkLocal(peer)) {
    return xReal ?? xff ?? peer;
  }
  return peer ?? "unknown-ip";
}

export function peerRemoteAddress(nodeEnv: unknown): string | undefined {
  if (!nodeEnv || typeof nodeEnv !== "object") return undefined;
  const incoming = (nodeEnv as { incoming?: unknown }).incoming;
  if (!incoming || typeof incoming !== "object") return undefined;
  const socket = (incoming as { socket?: unknown }).socket;
  if (!socket || typeof socket !== "object") return undefined;
  const remote = (socket as { remoteAddress?: unknown }).remoteAddress;
  return typeof remote === "string" ? remote : undefined;
}

export function withTrustedClientIp(request: Request, peerAddress: string | undefined): Request {
  const headers = new Headers(request.headers);
  headers.delete("cf-connecting-ip");
  const clientIp = resolveTrustedClientIp(peerAddress, headers);
  if (clientIp !== "unknown-ip") headers.set("cf-connecting-ip", clientIp);
  return new Request(request, { headers });
}

export function applySelfHostFetchTrustedClientIp(request: Request, nodeEnv: unknown): Request {
  return withTrustedClientIp(request, peerRemoteAddress(nodeEnv));
}

function stripIpv4MappedPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function normalizeIpAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !isValidIpAddress(trimmed)) return undefined;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

function isValidIpAddress(value: string): boolean {
  return isValidIpv4(value) || isValidIpv6(value);
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return false;
  }
  return true;
}

function isValidIpv6(value: string): boolean {
  let candidate = value;
  if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1);
  if (!candidate.includes(":") || !/^[0-9a-fA-F:.]+$/.test(candidate)) return false;
  if (candidate.split("::").length > 2) return false;
  const segments = candidate.split(":");
  if (segments.length > 8) return false;
  let hasHexSegment = false;
  for (const segment of segments) {
    if (segment === "") continue;
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return false;
    hasHexSegment = true;
  }
  return hasHexSegment;
}

export function isPrivateOrLinkLocal(ip: string): boolean {
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("FE80:")) return true;
  if (/^[fF][cCdD]/.test(ip)) return true;

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
