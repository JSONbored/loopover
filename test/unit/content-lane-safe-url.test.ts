import { describe, expect, it } from "vitest";
import { isSafeEndpointUrl, isSafeHttpUrl } from "../../src/review/content-lane/safe-url";

describe("isSafeHttpUrl", () => {
  it("accepts public https hosts", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("https://docs.anthropic.com/path")).toBe(true);
  });

  it("rejects non-https", () => {
    expect(isSafeHttpUrl("http://example.com")).toBe(false);
    expect(isSafeHttpUrl("ftp://example.com")).toBe(false);
    expect(isSafeHttpUrl("wss://example.com")).toBe(false);
  });

  it("rejects loopback / localhost / private-range hosts", () => {
    expect(isSafeHttpUrl("https://localhost")).toBe(false);
    expect(isSafeHttpUrl("https://127.0.0.1")).toBe(false);
    expect(isSafeHttpUrl("https://10.0.0.1")).toBe(false);
    expect(isSafeHttpUrl("https://192.168.1.1")).toBe(false);
    expect(isSafeHttpUrl("https://172.16.0.1")).toBe(false);
    expect(isSafeHttpUrl("https://169.254.169.254")).toBe(false); // cloud metadata
    expect(isSafeHttpUrl("https://service.internal")).toBe(false);
    expect(isSafeHttpUrl("https://printer.local")).toBe(false);
  });

  it("rejects encoded-IP SSRF bypasses that a dotted-quad regex misses", () => {
    expect(isSafeHttpUrl("https://2130706433")).toBe(false); // decimal 127.0.0.1
    expect(isSafeHttpUrl("https://0x7f000001")).toBe(false); // hex 127.0.0.1
    expect(isSafeHttpUrl("https://127.1")).toBe(false); // short form
  });

  it("rejects IPv6 loopback / ULA / link-local", () => {
    expect(isSafeHttpUrl("https://[::1]")).toBe(false);
    expect(isSafeHttpUrl("https://[fc00::1]")).toBe(false);
    expect(isSafeHttpUrl("https://[fe80::1]")).toBe(false);
  });

  it("rejects the all-zeros IPv6 unspecified address [::]", () => {
    // [::] is NOT caught by hostIsPrivateOrLocal's literal "::1"/"[::1]" guard (line 69),
    // so it falls through to ipv6IsPrivateOrLocal where `addr === "::"` matches (line 51).
    // The fd-prefix check would also pass it, but the "::" equality fires first.
    expect(isSafeHttpUrl("https://[::]")).toBe(false);
    expect(isSafeEndpointUrl("wss://[::]")).toBe(false);
  });

  it("accepts an fd00-prefixed ULA only when... it never does — fd is always private", () => {
    // fd00::/8 (ULA) — first hextet starts with "fd" → ipv6IsPrivateOrLocal line 61 true.
    expect(isSafeHttpUrl("https://[fd12:3456:789a::1]")).toBe(false);
  });

  it("returns false for unparseable input", () => {
    expect(isSafeHttpUrl("not a url")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });

  it("treats hex/octal-prefixed labels in a non-IP host as a public domain", () => {
    // `0x7f.example` survives the WHATWG parser as a hostname (not a whole-IP), so it reaches
    // ipv4ToInt: the first label exercises parseIpv4Component's hex branch (line 12), the second
    // ("example") returns null and ipv4ToInt bails — host is not a private IP literal → public.
    expect(isSafeHttpUrl("https://0x7f.example")).toBe(true);
    // `0177.example` exercises the octal branch (line 13) the same way.
    expect(isSafeHttpUrl("https://0177.example")).toBe(true);
    // A large hex label still bails on the trailing non-numeric label → public domain.
    expect(isSafeHttpUrl("https://0xffffffff.example")).toBe(true);
  });

  it("rejects nothing for a 5-label host (ipv4ToInt's >4-parts guard)", () => {
    // `a.b.c.d.e` has 5 dot-separated labels → ipv4ToInt returns null at the parts.length>4
    // guard (line 20) → not a private IP literal → treated as a public host.
    expect(isSafeHttpUrl("https://a.b.c.d.e")).toBe(true);
  });

  it("accepts public IPv4 literals (the non-private fall-through)", () => {
    // Exercises ipv4IsPrivateOrLocal's final `return false` for a routable public IP.
    expect(isSafeHttpUrl("https://8.8.8.8")).toBe(true);
    expect(isSafeHttpUrl("https://1.1.1.1")).toBe(true);
    // 172.x outside the 16-31 private band is public.
    expect(isSafeHttpUrl("https://172.15.0.1")).toBe(true);
    expect(isSafeHttpUrl("https://172.32.0.1")).toBe(true);
  });

  it("rejects an IPv4-mapped IPv6 in ::ffff:HHHH:HHHH hex form pointing at a private IP", () => {
    // ::ffff:7f00:0001 == 127.0.0.1 — exercises the hex-mapped IPv6 branch.
    expect(isSafeHttpUrl("https://[::ffff:7f00:0001]")).toBe(false);
    // ::ffff:c0a8:0101 == 192.168.1.1
    expect(isSafeHttpUrl("https://[::ffff:c0a8:0101]")).toBe(false);
  });

  it("accepts an IPv4-mapped IPv6 (hex form) pointing at a public IP", () => {
    // ::ffff:0808:0808 == 8.8.8.8 — hex branch returns the public verdict.
    expect(isSafeHttpUrl("https://[::ffff:0808:0808]")).toBe(true);
  });

  it("accepts a public IPv6 literal (the IPv6 non-private fall-through)", () => {
    // Exercises ipv6IsPrivateOrLocal's final `return false` (not loopback/ULA/link-local/mapped).
    expect(isSafeHttpUrl("https://[2001:4860:4860::8888]")).toBe(true);
  });
});

describe("isSafeEndpointUrl", () => {
  it("additionally permits wss / ws for chain endpoints", () => {
    expect(isSafeEndpointUrl("wss://entrypoint.example.com")).toBe(true);
    expect(isSafeEndpointUrl("ws://node.example.com")).toBe(true);
    expect(isSafeEndpointUrl("https://api.example.com")).toBe(true);
  });

  it("still applies the SSRF host guard to wss endpoints", () => {
    expect(isSafeEndpointUrl("wss://127.0.0.1")).toBe(false);
    expect(isSafeEndpointUrl("wss://localhost")).toBe(false);
  });

  it("rejects non-ws/https protocols", () => {
    expect(isSafeEndpointUrl("http://example.com")).toBe(false);
    expect(isSafeEndpointUrl("ftp://example.com")).toBe(false);
  });

  it("returns false for unparseable endpoint input (the URL-parse catch)", () => {
    expect(isSafeEndpointUrl("not a url")).toBe(false);
    expect(isSafeEndpointUrl("")).toBe(false);
  });
});
