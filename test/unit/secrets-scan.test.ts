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

  // #2553: widened to match review-enrichment/src/analyzers/secret-scan.ts's richer rule set.
  it("flags a Google API key", () => {
    const fakeKey = "AIza" + "SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";
    expect(scanForSecrets(fakeKey).kinds).toContain("google_api_key");
  });

  it("flags a GitLab access token", () => {
    const fakeToken = "glpat-" + "aBcDeFgHiJkLmNoPqRsT";
    expect(scanForSecrets(fakeToken).kinds).toContain("gitlab_token");
  });

  it("flags a GitLab access token whose final token character is a hyphen", () => {
    const fakeToken = "glpat-" + "aBcDeFgHiJkLmNoPqRs-";
    expect(scanForSecrets(`gitlab = "${fakeToken}"`).kinds).toContain("gitlab_token");
  });

  it("does not flag a GitLab-shaped run that continues past the expected 20-char token length", () => {
    const overrun = "glpat-" + "aBcDeFgHiJkLmNoPqRsT" + "X"; // 21 token-alphabet chars after the prefix
    expect(scanForSecrets(overrun).kinds).not.toContain("gitlab_token");
  });

  it("flags an npm token", () => {
    const fakeToken = "npm_" + "a".repeat(36);
    expect(scanForSecrets(fakeToken).kinds).toContain("npm_token");
  });

  it("flags a Stripe live secret key", () => {
    const fakeToken = "sk_live_" + "a".repeat(24);
    expect(scanForSecrets(fakeToken).kinds).toContain("stripe_secret_key");
  });

  it("flags a SendGrid API key", () => {
    const fakeToken = "SG." + "a".repeat(22) + "." + "b".repeat(43);
    expect(scanForSecrets(fakeToken).kinds).toContain("sendgrid_key");
  });

  it("flags a SendGrid API key whose final secret character is a hyphen", () => {
    // Regression: a `\b` terminator would miss a key ending in `-` (a `-` before a
    // quote/space is not a word boundary), so the rule uses a negative lookahead.
    const fakeToken = "SG." + "a".repeat(22) + "." + "b".repeat(42) + "-";
    expect(scanForSecrets(`sg = "${fakeToken}"`).kinds).toContain("sendgrid_key");
  });

  it("flags a Hugging Face access token", () => {
    const fakeToken = "hf_" + "a".repeat(34);
    expect(scanForSecrets(fakeToken).kinds).toContain("huggingface_token");
  });

  it("flags a JWT", () => {
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scanForSecrets(fakeJwt).kinds).toContain("jwt");
  });

  it("flags a generic secret/password/token assignment with a high-entropy value", () => {
    // Mixed case + digits with no monotonic character-code run (unlike a plain "ABCDEFGH..." fixture, which
    // the sequential-run filter below would correctly treat as a low-entropy placeholder, not a real secret).
    const fakeSecret = "sk_live_" + "aK9xQ2mZw7Ln4Rv8Pt3Bh6";
    expect(scanForSecrets(`secret = "${fakeSecret}"`).kinds).toContain("generic_secret_assignment");
    expect(scanForSecrets(`password: "${fakeSecret}"`).kinds).toContain("generic_secret_assignment");
    expect(scanForSecrets(`client_secret = "${fakeSecret}"`).kinds).toContain("generic_secret_assignment");
    expect(scanForSecrets(`api_key: '${fakeSecret}'`).kinds).toContain("generic_secret_assignment");
  });

  it.each([
    ["ascending run", 'token = "abcdefghijklmnop123"'],
    ["descending run", 'secret = "zyxwvutsrqponmlkj987"'],
  ])("does NOT flag a long monotonic character-code run: %s (gate finding: high distinct-char count is not high entropy)", (_name, snippet) => {
    expect(scanForSecrets(snippet).kinds).not.toContain("generic_secret_assignment");
  });

  it("does NOT flag a Zod/type schema field declaration with no literal value", () => {
    expect(scanForSecrets('password: z.string()').kinds).not.toContain("generic_secret_assignment");
    expect(scanForSecrets("type Config = { secretKey: string; apiKey?: string }").kinds).not.toContain("generic_secret_assignment");
  });

  it.each([
    ["xxx", 'token = "xxx"'],
    ["placeholder phrase", 'secret = "your-api-key-placeholder"'],
    ["angle-bracket placeholder", 'password: "<REDACTED-VALUE-HERE>"'],
    ["changeme", 'client_secret: "changeme-please-changeme"'],
    ["repeated-character filler", 'api_key = "xxxxxxxxxxxxxxxxxxxx"'],
    ["your- prefix", 'token: "your-secret-token-value"'],
  ])("does NOT flag a redacted/placeholder value: %s", (_name, snippet) => {
    expect(scanForSecrets(snippet).kinds).not.toContain("generic_secret_assignment");
  });

  it("does NOT flag a short value under the 16-character floor", () => {
    expect(scanForSecrets('token = "short12345"').kinds).not.toContain("generic_secret_assignment");
  });

  // #3041: PR #3036 was wrongly hard-blocked by the test-fixture literal "installation-token" (used 351+
  // times across this repo's own test suite as a mock fetch-response token) — a lowercase-hyphenated word
  // compound reads as a fixture/mock name, not a generated credential.
  it.each([
    ["installation-token", 'token: "installation-token"'],
    ["access-token", 'token = "access-token"'],
    ["some-mock-secret-value", 'secret: "some-mock-secret-value"'],
  ])("does NOT flag a lowercase-hyphenated word compound: %s (#3041)", (_name, snippet) => {
    expect(scanForSecrets(snippet).kinds).not.toContain("generic_secret_assignment");
  });

  it("still flags a real-looking generic secret with digits and mixed case (regression guard for #3041)", () => {
    // Same fixture as the "high-entropy value" test above — proves the new lowercase-hyphenated exclusion
    // doesn't broaden past its intended narrow shape: this value has digits + mixed case, not a pure
    // lowercase-hyphenated phrase, so it must still be flagged.
    const fakeSecret = "sk_live_" + "aK9xQ2mZw7Ln4Rv8Pt3Bh6";
    expect(scanForSecrets(`fakeSecret = "${fakeSecret}"`).kinds).toContain("generic_secret_assignment");
  });

  it("a single lowercase word with no hyphen is unaffected by the new hyphenated-compound exclusion (#3041)", () => {
    // 20 lowercase letters, no repeats and no sequential run, so it isn't already caught by the entropy/
    // placeholder checks either -- proves LOWERCASE_HYPHENATED_COMPOUND_PATTERN specifically requires a
    // hyphen (2+ segments) and does not accidentally match a single unhyphenated word.
    const singleWord = "qwzxvbnmalskdjfhgpoiu";
    expect(scanForSecrets(`token = "${singleWord}"`).kinds).toContain("generic_secret_assignment");
  });
});
