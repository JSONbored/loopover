import { describe, expect, it } from "vitest";

import {
  buildClearedBrowserSessionCookie,
  buildClearedGitHubOAuthStateCookie,
  buildGitHubOAuthStateCookie,
  extractBearerToken,
  extractBrowserSessionToken,
  extractCookieValue,
} from "../../src/auth/security";

describe("extractBearerToken", () => {
  it("returns the token for well-formed Bearer headers regardless of casing", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("BEARER abc123")).toBe("abc123");
  });

  it("collapses surrounding whitespace and tabs around the token", () => {
    expect(extractBearerToken("Bearer    abc123")).toBe("abc123");
    expect(extractBearerToken("Bearer abc123   ")).toBe("abc123");
    expect(extractBearerToken("Bearer\tabc123")).toBe("abc123");
    expect(extractBearerToken("Bearer  multi part token ")).toBe(
      "multi part token",
    );
  });

  it("returns undefined for missing, empty, or non-Bearer headers", () => {
    for (const header of [
      null,
      undefined,
      "",
      "Bearer",
      "Bearer ",
      "Basic abc123",
      "Token abc123",
      "abc123",
    ]) {
      expect(extractBearerToken(header)).toBeUndefined();
    }
  });
});

describe("extractCookieValue", () => {
  it("reads a named cookie from a multi-cookie header", () => {
    expect(extractCookieValue("a=1; target=hello; b=2", "target")).toBe(
      "hello",
    );
    expect(extractCookieValue("target=hello", "target")).toBe("hello");
  });

  it("URL-decodes the value and preserves '=' inside it", () => {
    expect(extractCookieValue("target=a%20b", "target")).toBe("a b");
    expect(extractCookieValue("target=a=b=c", "target")).toBe("a=b=c");
  });

  it("returns undefined when the cookie is absent, the header is empty, or decoding fails", () => {
    expect(extractCookieValue("other=1", "target")).toBeUndefined();
    expect(extractCookieValue("", "target")).toBeUndefined();
    expect(extractCookieValue(null, "target")).toBeUndefined();
    expect(extractCookieValue(undefined, "target")).toBeUndefined();
    expect(extractCookieValue("target=%E0%A4%A", "target")).toBeUndefined();
  });
});

describe("extractBrowserSessionToken", () => {
  it("extracts the gittensory_session cookie value", () => {
    expect(extractBrowserSessionToken("gittensory_session=tok123")).toBe(
      "tok123",
    );
    expect(
      extractBrowserSessionToken("a=1; gittensory_session=tok123; b=2"),
    ).toBe("tok123");
  });

  it("returns an empty string for a present-but-empty cookie and undefined when absent", () => {
    expect(extractBrowserSessionToken("gittensory_session=")).toBe("");
    expect(extractBrowserSessionToken("other=1")).toBeUndefined();
    expect(extractBrowserSessionToken(null)).toBeUndefined();
  });
});

describe("session/oauth cookie builders", () => {
  it("clears the browser session cookie with Max-Age=0 and Secure on remote hosts", () => {
    expect(
      buildClearedBrowserSessionCookie("https://app.example.com/auth"),
    ).toBe(
      "gittensory_session=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly; Secure",
    );
  });

  it("omits Secure only for localhost/loopback hosts", () => {
    expect(buildClearedBrowserSessionCookie("http://localhost:8787/auth")).toBe(
      "gittensory_session=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly",
    );
    expect(buildClearedBrowserSessionCookie("http://127.0.0.1/auth")).toBe(
      "gittensory_session=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly",
    );
    // Secure keys off hostname, not scheme: a plain-http remote host still gets Secure.
    expect(
      buildClearedBrowserSessionCookie("http://example.com/auth"),
    ).toContain("; Secure");
    // Unparseable URLs fall back to Secure.
    expect(buildClearedBrowserSessionCookie("not-a-url")).toContain("; Secure");
  });

  it("issues the oauth state cookie with the scoped path, 10-minute Max-Age, and encoded value", () => {
    expect(
      buildGitHubOAuthStateCookie("xyz789", "https://app.example.com"),
    ).toBe(
      "gittensory_oauth_state=xyz789; Max-Age=600; Path=/v1/auth/github; SameSite=Lax; HttpOnly; Secure",
    );
    expect(
      buildGitHubOAuthStateCookie("a b/c+d", "https://app.example.com"),
    ).toBe(
      "gittensory_oauth_state=a%20b%2Fc%2Bd; Max-Age=600; Path=/v1/auth/github; SameSite=Lax; HttpOnly; Secure",
    );
  });

  it("clears the oauth state cookie on the same scoped path", () => {
    expect(buildClearedGitHubOAuthStateCookie("https://app.example.com")).toBe(
      "gittensory_oauth_state=; Max-Age=0; Path=/v1/auth/github; SameSite=Lax; HttpOnly; Secure",
    );
    expect(buildClearedGitHubOAuthStateCookie("http://localhost/cb")).toBe(
      "gittensory_oauth_state=; Max-Age=0; Path=/v1/auth/github; SameSite=Lax; HttpOnly",
    );
  });
});
