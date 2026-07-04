// Units for the secret-scan analyzer. Kept separate so analyzer PRs do not collide in one shared test file.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scanPatch } from "../dist/analyzers/secret-scan.js";

const hunk = (lines) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

// Built from fragments at test-run time (never a contiguous secret-shaped literal in the committed source) so
// GitHub push protection does not flag this fixture file the way it would flag a real leaked credential — the
// fragments below are only ever joined into one string inside the synthetic diff patch handed to scanPatch, or
// (for the cross-line tests) deliberately kept as two SEPARATE short literals that mirror what a real split
// secret looks like in source — neither fragment alone is a contiguous match for any RULES pattern.
const awsKeyFragmentA = "AKIA" + "IOSFODNN7"; // 13 chars — too short alone to match \bAKIA[0-9A-Z]{16}\b
const awsKeyFragmentB = "EXAMPLE"; // matches no RULES pattern alone
const fakeAwsKey = awsKeyFragmentA + awsKeyFragmentB;
const fakeStripeKey = ["sk_live_", "abcdefghijklmnop1234567890"].join(""); // sk_live_ + 26 base62
const fakeSendgridKey = ["SG.", "a".repeat(22), ".", "b".repeat(43)].join("");
const fakeHuggingfaceToken = "hf_" + "a".repeat(34);
// Anthropic keys are `sk-ant-` + a long base64url body (built from fragments so push protection
// never sees a contiguous secret-shaped literal in the committed source).
const fakeAnthropicKey = ["sk-ant-", "api03-", "a".repeat(20)].join("");
const fakeGitlabToken = "glpat-" + "aBcDeFgHiJkLmNoPqRsT"; // 20 chars after the prefix
const fakeNpmToken = "npm_" + "a".repeat(36);
// A high-entropy value that matches NO format-specific rule, so it only trips the
// generic keyword-assignment rule (built from fragments, never a contiguous literal).
const fakeGenericValue = "aK9xQ2mZw7Ln" + "4Rv8Pt3Bh6Tc";

test("scanPatch flags a single-line AWS access key with high confidence", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const key = "${fakeAwsKey}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "aws_access_key_id");
  assert.equal(findings[0].confidence, "high");
  assert.equal(findings[0].file, "src/config.ts");
  assert.equal(findings[0].line, 1);
});

test("scanPatch flags a private key header", () => {
  const findings = scanPatch(
    "id_rsa",
    hunk(["-----BEGIN RSA PRIVATE KEY-----"]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "private_key");
});

test("scanPatch flags a GitLab access token with high confidence", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const gl = "${fakeGitlabToken}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "gitlab_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags an npm token with high confidence", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const registryAuth = "${fakeNpmToken}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "npm_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a Stripe live secret key with high confidence", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const apiKey = "${fakeStripeKey}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "stripe_secret_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a SendGrid API key with high confidence", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const sg = "${fakeSendgridKey}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sendgrid_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a SendGrid key whose final secret character is a hyphen", () => {
  // Regression: a `\b` terminator would miss a key ending in `-`; the rule uses a
  // negative lookahead so the trailing hyphen still terminates the match.
  const hyphenTail = ["SG.", "a".repeat(22), ".", "b".repeat(42), "-"].join("");
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const sg = "${hyphenTail}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sendgrid_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a Hugging Face access token with high confidence", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const hfToken = "${fakeHuggingfaceToken}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "huggingface_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags an Anthropic API key with high confidence", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const anthropicKey = "${fakeAnthropicKey}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "anthropic_api_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags an Anthropic key whose final body character is a hyphen", () => {
  // Regression: a `\b` terminator would miss a key ending in `-`; the rule uses a
  // negative lookahead so the trailing hyphen still terminates the match (same as SendGrid).
  const hyphenTail = ["sk-ant-", "api03-", "a".repeat(19), "-"].join("");
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const anthropicKey = "${hyphenTail}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "anthropic_api_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch does not flag Stripe live keys as Anthropic keys", () => {
  // Stripe uses `sk_live_` (underscore); Anthropic uses `sk-ant-` (hyphen). The two must not cross-match.
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const apiKey = "${fakeStripeKey}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "stripe_secret_key");
});

test("scanPatch flags a generic secret assignment", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const apiKey = "${fakeGenericValue}";`]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "generic_secret_assignment");
  assert.equal(findings[0].confidence, "medium");
});

test("scanPatch reports nothing for clean code", () => {
  const findings = scanPatch(
    "src/app.ts",
    hunk(['const greeting = "hello world";', "export function run() {}"]),
  );
  assert.equal(findings.length, 0);
});

// Regression test for #2454: a real credential split across two added lines via string concatenation evaded
// every RULES regex since neither line's own text contains the full contiguous pattern.
test("scanPatch catches an AWS key split across two adjacent added lines via concatenation (#2454)", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([
      `const part1 = "${awsKeyFragmentA}";`,
      `const part2 = "${awsKeyFragmentB}";`,
      "const awsKey = part1 + part2;",
    ]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "aws_access_key_id");
  assert.equal(findings[0].confidence, "medium"); // downgraded — a joined pair is a heuristic, not a direct match
  assert.equal(findings[0].line, 2); // attributed to the completing (second) line
});

test("scanPatch does not join literals across a context line that breaks the added-line run (#2454)", () => {
  const patch = [
    "@@ -1,1 +1,3 @@",
    ' const unrelated = "context line";', // unchanged context line breaks the run
    `+const part1 = "${awsKeyFragmentA}";`,
    `+const part2 = "${awsKeyFragmentB}";`,
  ].join("\n");
  // part1 and part2 ARE still adjacent added lines here, so this should still match — this test instead
  // verifies a context line BETWEEN the two secret halves prevents the join.
  const findingsAdjacent = scanPatch("src/config.ts", patch);
  assert.equal(findingsAdjacent.length, 1);

  const patchWithGap = [
    "@@ -1,1 +1,3 @@",
    `+const part1 = "${awsKeyFragmentA}";`,
    ' const unrelated = "context line";',
    `+const part2 = "${awsKeyFragmentB}";`,
  ].join("\n");
  const findingsGapped = scanPatch("src/config.ts", patchWithGap);
  assert.equal(findingsGapped.length, 0);
});

test("scanPatch does not join literals across a hunk boundary (#2454)", () => {
  const patch = [
    "@@ -1,0 +1,1 @@",
    `+const part1 = "${awsKeyFragmentA}";`,
    "@@ -10,0 +11,1 @@",
    `+const part2 = "${awsKeyFragmentB}";`,
  ].join("\n");
  const findings = scanPatch("src/config.ts", patch);
  assert.equal(findings.length, 0);
});

test("scanPatch does not double-report a line that already matched on its own", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([
      `const key = "${fakeAwsKey}";`,
      'const other = "unrelated-string-value";',
    ]),
  );
  // The first line already matches directly; its literal must not ALSO be joined into a second, duplicate finding.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
});

test("scanPatch does not join two unrelated short literals into a false positive", () => {
  const findings = scanPatch(
    "src/app.ts",
    hunk(['const a = "hello";', 'const b = "world";']),
  );
  assert.equal(findings.length, 0);
});

// Regression: an added line whose content starts with `++` renders as `+++...` in the diff. A header-prefix
// guard (even the anchored `+++ `) mistakes it for a `+++ b/file` header and skips it, so a secret on such a
// line is never scanned. Both `++x` (-> `+++x`) and `++ x` (-> `+++ x`) content shapes must be scanned.
for (const content of [
  '++const key = "AWS_KEY";',
  '++ const key = "AWS_KEY";',
]) {
  test(`scanPatch scans an added line whose content starts with ++ (rendered +${content})`, () => {
    const patch = `@@ -1,0 +1,1 @@\n+${content.replace("AWS_KEY", fakeAwsKey)}`;
    const findings = scanPatch("src/config.ts", patch);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "aws_access_key_id");
    assert.equal(findings[0].line, 1);
  });
}
