// SSRF-safe URL guard (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to reviewbot's
// core/source-url.ts isSafeHttpUrl + isSafeEndpointUrl (the host/IP guard, including the encoded-IP
// decoding that a dotted-quad regex misses). PURE — no imports, no I/O.
//
// Rejects non-HTTPS (isSafeHttpUrl), localhost/.local/.internal, and private/loopback/link-local
// IPs in any literal notation (decimal `2130706433`, hex `0x7f000001`, octal, short `127.1`, and the
// IPv6 forms). isSafeEndpointUrl additionally permits wss:/ws: for base-layer chain endpoints.

function parseIpv4Component(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8); // leading-zero → octal
  if (/^(?:0|[1-9]\d*)$/.test(part)) return parseInt(part, 10);
  return null;
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const part of parts) {
    const v = parseIpv4Component(part);
    if (v === null || !Number.isFinite(v) || v < 0) return null;
    vals.push(v);
  }
  const n = vals.length;
  for (let i = 0; i < n - 1; i += 1) if ((vals[i] as number) > 0xff) return null;
  const lastMax = [0xffffffff, 0xffffff, 0xffff, 0xff][n - 1] as number;
  if ((vals[n - 1] as number) > lastMax) return null;
  let result = vals[n - 1] as number;
  for (let i = 0; i < n - 1; i += 1) result += (vals[i] as number) * 256 ** (3 - i);
  return result > 0xffffffff ? null : result >>> 0;
}

function ipv4IsPrivateOrLocal(host: string): boolean {
  const n = ipv4ToInt(host);
  if (n === null) return false;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function ipv6IsPrivateOrLocal(host: string): boolean {
  const addr = host.replace(/^\[|\]$/g, "");
  if (!addr.includes(":")) return false;
  if (addr === "::1" || addr === "::") return true;
  const dotted = addr.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return ipv4IsPrivateOrLocal(dotted[1] as string);
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1] as string, 16);
    const lo = parseInt(hex[2] as string, 16);
    return ipv4IsPrivateOrLocal(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  const first = addr.split(":")[0] as string;
  if (first.startsWith("fc") || first.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(first)) return true; // link-local fe80::/10
  return false;
}

function hostIsPrivateOrLocal(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (h.includes(":")) return ipv6IsPrivateOrLocal(h);
  return ipv4IsPrivateOrLocal(h);
}

/** https + public (non-loopback, non-private) host. */
export function isSafeHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return !hostIsPrivateOrLocal(url.hostname.toLowerCase());
}

/** Like isSafeHttpUrl but also permits secure WebSocket endpoints (`wss:`, `ws:`) — base-layer chain
 *  endpoints (subtensor RPC/WSS/archive) are probed via JSON-RPC, not HTTP. Same SSRF host/IP guard. */
export function isSafeEndpointUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!["https:", "wss:", "ws:"].includes(url.protocol)) return false;
  return !hostIsPrivateOrLocal(url.hostname.toLowerCase());
}
