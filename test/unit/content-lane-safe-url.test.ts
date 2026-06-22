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

  it("returns false for unparseable input", () => {
    expect(isSafeHttpUrl("not a url")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
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
});
