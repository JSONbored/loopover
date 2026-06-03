import { describe, expect, it } from "vitest";
import { isSessionExpired, looksLikeGitHubPersonalAccessToken, normalizeApiOrigin, validateGittensorySessionToken } from "../lib/config";
import { VALID_SESSION_TOKEN } from "./helpers";

describe("normalizeApiOrigin", () => {
  it("defaults invalid origins to production API", () => {
    expect(normalizeApiOrigin("")).toBe("https://gittensory-api.aethereal.dev");
    expect(normalizeApiOrigin("not-a-url")).toBe("https://gittensory-api.aethereal.dev");
    expect(normalizeApiOrigin("http://evil.example")).toBe("https://gittensory-api.aethereal.dev");
  });

  it("allows localhost and https origins", () => {
    expect(normalizeApiOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeApiOrigin("https://preview.example")).toBe("https://preview.example");
  });
});

describe("validateGittensorySessionToken", () => {
  it("rejects GitHub PAT prefixes", () => {
    expect(() => validateGittensorySessionToken("ghp_deadbeef")).toThrow(/personal access tokens/i);
    expect(() => validateGittensorySessionToken("github_pat_deadbeef")).toThrow(/personal access tokens/i);
  });

  it("accepts gts session tokens", () => {
    expect(validateGittensorySessionToken(VALID_SESSION_TOKEN)).toBe(VALID_SESSION_TOKEN);
    expect(() => validateGittensorySessionToken("gts_short")).toThrow(/gts_/i);
    expect(() => validateGittensorySessionToken("")).toThrow(/required/i);
  });
});

describe("looksLikeGitHubPersonalAccessToken", () => {
  it("detects github token prefixes", () => {
    expect(looksLikeGitHubPersonalAccessToken("gho_abc")).toBe(true);
    expect(looksLikeGitHubPersonalAccessToken(VALID_SESSION_TOKEN)).toBe(false);
  });
});

describe("isSessionExpired", () => {
  it("treats past timestamps as expired", () => {
    expect(isSessionExpired("2000-01-01T00:00:00.000Z", Date.parse("2020-01-01T00:00:00.000Z"))).toBe(true);
    expect(isSessionExpired("", Date.now())).toBe(false);
    expect(isSessionExpired("invalid", Date.now())).toBe(false);
  });
});
