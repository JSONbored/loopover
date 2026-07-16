// Resolve the real client IP for self-host rate limiting (#critical: cf-connecting-ip spoof).
//
// On Cloudflare Workers, `cf-connecting-ip` is edge-set and safe for `clientIp()` in auth/rate-limit.ts.
// On Node self-host the same header is just another request header — fully attacker-controlled — while
// Redis RATE_LIMITER IS bound (server.ts). Caddy (caddy/Caddyfile) injects X-Real-IP / X-Forwarded-For
// from `{remote_host}` but does not set or strip `cf-connecting-ip`.
//
// This module overwrites `cf-connecting-ip` at the Node edge before the Worker fetch runs:
//   • Always delete any client-supplied `cf-connecting-ip` (never trust it on Node).
//   • If the TCP peer is a private/link-local/loopback hop (compose Caddy → app), prefer Caddy's
//     X-Real-IP, then the leftmost X-Forwarded-For hop.
//   • Otherwise use the TCP peer (direct :8787 expose) and ignore proxy headers (client-spoofable).
// Workers remain unchanged: they never call this helper.
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

/** Return a Request whose `cf-connecting-ip` is the Node-edge-trusted client IP (see resolveTrustedClientIp). */
export function withTrustedClientIp(request: Request, peerAddress: string | undefined): Request {
  const headers = new Headers(request.headers);
  headers.delete("cf-connecting-ip");
  const clientIp = resolveTrustedClientIp(peerAddress, headers);
  if (clientIp !== "unknown-ip") headers.set("cf-connecting-ip", clientIp);
  return new Request(request, { headers });
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

/** RFC1918 / link-local / loopback — the hop we see when Caddy (or another compose proxy) fronts the app. */
export function isPrivateOrLinkLocal(ip: string): boolean {
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("FE80:")) return true;
  // Unique-local IPv6 (fc00::/7)
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
