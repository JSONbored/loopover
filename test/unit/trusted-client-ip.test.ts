import { describe, expect, it } from "vitest";
import {
  isPrivateOrLinkLocal,
  peerRemoteAddress,
  resolveTrustedClientIp,
  withTrustedClientIp,
} from "../../src/selfhost/trusted-client-ip";

describe("trusted-client-ip (self-host rate-limit identity)", () => {
  it("REGRESSION: ignores client-spoofed cf-connecting-ip when the TCP peer is public (direct expose)", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.1",
      "x-real-ip": "198.51.100.9",
      "x-forwarded-for": "198.51.100.9",
    });
    // Public peer → use peer; proxy/CF headers are client-controlled on a direct :8787 path.
    expect(resolveTrustedClientIp("203.0.113.50", headers)).toBe("203.0.113.50");
    expect(resolveTrustedClientIp("203.0.113.51", headers)).toBe("203.0.113.51");
  });

  it("REGRESSION: behind a private proxy hop (Caddy), prefers X-Real-IP over a spoofed cf-connecting-ip", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.1",
      "x-real-ip": "198.51.100.20",
      "x-forwarded-for": "198.51.100.20",
    });
    expect(resolveTrustedClientIp("10.0.0.2", headers)).toBe("198.51.100.20");
    expect(resolveTrustedClientIp("172.16.5.1", headers)).toBe("198.51.100.20");
    expect(resolveTrustedClientIp("192.168.1.1", headers)).toBe("198.51.100.20");
  });

  it("falls back to leftmost X-Forwarded-For when X-Real-IP is absent behind a private hop", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.30, 10.0.0.2",
    });
    expect(resolveTrustedClientIp("10.0.0.2", headers)).toBe("198.51.100.30");
  });

  it("uses the private peer itself when Caddy headers are missing", () => {
    expect(resolveTrustedClientIp("10.0.0.2", new Headers({ "cf-connecting-ip": "1.2.3.4" }))).toBe("10.0.0.2");
  });

  it("returns unknown-ip when no usable peer or proxy header is present", () => {
    expect(resolveTrustedClientIp(undefined, new Headers({ "cf-connecting-ip": "203.0.113.1" }))).toBe("unknown-ip");
    expect(resolveTrustedClientIp("not-an-ip", new Headers())).toBe("unknown-ip");
  });

  it("strips IPv4-mapped IPv6 peer prefixes", () => {
    expect(resolveTrustedClientIp("::ffff:203.0.113.50", new Headers())).toBe("203.0.113.50");
    expect(
      resolveTrustedClientIp("::ffff:10.0.0.2", new Headers({ "x-real-ip": "198.51.100.40" })),
    ).toBe("198.51.100.40");
  });

  it("withTrustedClientIp deletes spoofed cf-connecting-ip and sets the trusted value", () => {
    const original = new Request("https://orb.example/v1/auth/github/session", {
      headers: {
        "cf-connecting-ip": "203.0.113.1",
        "x-real-ip": "198.51.100.55",
      },
    });
    const trusted = withTrustedClientIp(original, "10.0.0.5");
    expect(trusted.headers.get("cf-connecting-ip")).toBe("198.51.100.55");
    expect(original.headers.get("cf-connecting-ip")).toBe("203.0.113.1");
  });

  it("withTrustedClientIp omits cf-connecting-ip when identity is unknown-ip", () => {
    const trusted = withTrustedClientIp(
      new Request("https://orb.example/health", { headers: { "cf-connecting-ip": "203.0.113.1" } }),
      undefined,
    );
    expect(trusted.headers.get("cf-connecting-ip")).toBeNull();
  });

  it("peerRemoteAddress reads the documented HttpBindings/Http2Bindings socket path", () => {
    expect(peerRemoteAddress({ incoming: { socket: { remoteAddress: "10.0.0.2" } } })).toBe("10.0.0.2");
    expect(peerRemoteAddress({ incoming: { socket: { remoteAddress: "203.0.113.9" } } })).toBe("203.0.113.9");
    expect(peerRemoteAddress({ incoming: { socket: null } })).toBeUndefined();
    expect(peerRemoteAddress({ incoming: null })).toBeUndefined();
    expect(peerRemoteAddress({})).toBeUndefined();
    expect(peerRemoteAddress(null)).toBeUndefined();
    expect(peerRemoteAddress(undefined)).toBeUndefined();
    expect(peerRemoteAddress({ incoming: { socket: { remoteAddress: 123 } } })).toBeUndefined();
  });

  it("accepts bracketed IPv6 peers/headers and rejects malformed IPv4/IPv6", () => {
    expect(
      resolveTrustedClientIp("[2001:db8::1]", new Headers()),
    ).toBe("2001:db8::1");
    expect(
      resolveTrustedClientIp("10.0.0.2", new Headers({ "x-real-ip": "[2001:db8::abcd]" })),
    ).toBe("2001:db8::abcd");
    expect(resolveTrustedClientIp("1.2.3", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("1.2.3.4.5", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("1.2.3.999", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("1.2.3.a", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("gggg::1", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("2001:db8::1::2", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("1:2:3:4:5:6:7:8:9", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("2001:db8::zzzz", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("notaip", new Headers())).toBe("unknown-ip");
    expect(resolveTrustedClientIp("[2001:db8::1", new Headers())).toBe("unknown-ip");
  });

  it("classifies expanded loopback and unique-local IPv6 peers", () => {
    expect(isPrivateOrLinkLocal("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateOrLinkLocal("FE80::1")).toBe(true);
    expect(isPrivateOrLinkLocal("fd12::1")).toBe(true);
    expect(isPrivateOrLinkLocal("not.an.ip.addr")).toBe(false);
    expect(isPrivateOrLinkLocal("8.8.8.8")).toBe(false);
  });

  it("falls through XFF when X-Real-IP is present but invalid behind a private hop", () => {
    expect(
      resolveTrustedClientIp(
        "10.0.0.2",
        new Headers({ "x-real-ip": "not-an-ip", "x-forwarded-for": "198.51.100.77, 10.0.0.2" }),
      ),
    ).toBe("198.51.100.77");
  });

  it("classifies private / link-local / loopback peers", () => {
    expect(isPrivateOrLinkLocal("10.1.2.3")).toBe(true);
    expect(isPrivateOrLinkLocal("192.168.0.1")).toBe(true);
    expect(isPrivateOrLinkLocal("172.16.0.1")).toBe(true);
    expect(isPrivateOrLinkLocal("172.31.255.255")).toBe(true);
    expect(isPrivateOrLinkLocal("127.0.0.1")).toBe(true);
    expect(isPrivateOrLinkLocal("169.254.1.1")).toBe(true);
    expect(isPrivateOrLinkLocal("::1")).toBe(true);
    expect(isPrivateOrLinkLocal("fe80::1")).toBe(true);
    expect(isPrivateOrLinkLocal("fc00::1")).toBe(true);
    expect(isPrivateOrLinkLocal("203.0.113.1")).toBe(false);
    expect(isPrivateOrLinkLocal("172.15.0.1")).toBe(false);
    expect(isPrivateOrLinkLocal("172.32.0.1")).toBe(false);
  });
});
