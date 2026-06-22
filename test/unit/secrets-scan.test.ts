import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../../src/review/secrets-scan";

describe("scanForSecrets — deterministic secret-pattern scanner", () => {
  it("returns no findings for empty / benign text", () => {
    expect(scanForSecrets("")).toEqual({ found: false, kinds: [] });
    expect(scanForSecrets("Just a normal description of a CLI tool that reads files.")).toEqual({ found: false, kinds: [] });
  });

  it("flags a GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)", () => {
    const r = scanForSecrets("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(r.found).toBe(true);
    expect(r.kinds).toContain("github_token");
  });

  it("flags a fine-grained GitHub PAT", () => {
    const r = scanForSecrets("github_pat_11ABCDEFG0123456789_abcdefghijklmnop");
    expect(r.found).toBe(true);
    expect(r.kinds).toContain("github_pat");
  });

  it("flags a private key block", () => {
    expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----").kinds).toContain("private_key_block");
    expect(scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").kinds).toContain("private_key_block");
    expect(scanForSecrets("-----BEGIN PRIVATE KEY-----").kinds).toContain("private_key_block");
  });

  it("flags an AWS access key id", () => {
    expect(scanForSecrets("AKIAIOSFODNN7EXAMPLE").kinds).toContain("aws_access_key");
  });

  it("flags a Slack token", () => {
    expect(scanForSecrets("xoxb-123456789012-ABCDEFabcdef").kinds).toContain("slack_token");
  });

  it("flags seed-phrase / mnemonic mentions (case-insensitive)", () => {
    expect(scanForSecrets("here is my SEED PHRASE for the wallet").kinds).toContain("seed_or_mnemonic");
    expect(scanForSecrets("recovery mnemonic below").kinds).toContain("seed_or_mnemonic");
  });

  it("flags a bittensor hotkey/coldkey assignment", () => {
    expect(scanForSecrets("hotkey = 5F3sa2...").kinds).toContain("bittensor_key");
    expect(scanForSecrets("coldkey: 5Gx...").kinds).toContain("bittensor_key");
  });

  it("collects multiple distinct kinds in one scan", () => {
    const r = scanForSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and AKIAIOSFODNN7EXAMPLE");
    expect(r.found).toBe(true);
    expect(r.kinds).toEqual(expect.arrayContaining(["github_token", "aws_access_key"]));
  });
});
