// Units for the secret-scan analyzer. Kept separate so analyzer PRs do not collide in one shared test file.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scanPatch } from "../dist/analyzers/secret-scan.js";

const hunk = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

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
// Anthropic keys are `sk-ant-` + a long base64url body (fragments only — never a contiguous literal in source).
const fakeAnthropicKey = ["sk-ant-", "api03-", "a".repeat(20)].join("");
// OpenAI project-scoped key: `sk-proj-` + base64url body (fragments only — never a contiguous literal).
const fakeOpenAiProjKey = ["sk-proj-", "T3BlbkFJ", "a".repeat(20)].join("");
const fakeGitlabToken = "glpat-" + "aBcDeFgHiJkLmNoPqRsT"; // 20 chars after the prefix
const fakeNpmToken = "npm_" + "a".repeat(36);
// GitHub fine-grained PAT: `github_pat_` + 82 base62/underscore chars (fragments only — never a contiguous
// literal in source, so push protection doesn't flag this fixture).
const fakeGithubPat = "github" + "_pat_" + "1".repeat(11) + "_" + "a".repeat(70);
// A high-entropy value that matches NO format-specific rule, so it only trips the
// generic keyword-assignment rule (built from fragments, never a contiguous literal).
const fakeGenericValue = "aK9xQ2mZw7Ln" + "4Rv8Pt3Bh6Tc";

test("scanPatch flags a single-line AWS access key with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const key = "${fakeAwsKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "aws_access_key_id");
  assert.equal(findings[0].confidence, "high");
  assert.equal(findings[0].file, "src/config.ts");
  assert.equal(findings[0].line, 1);
});

test("scanPatch flags a private key header", () => {
  const findings = scanPatch("id_rsa", hunk(["-----BEGIN RSA PRIVATE KEY-----"]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "private_key");
});

test("scanPatch flags a GitLab access token with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const gl = "${fakeGitlabToken}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "gitlab_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags an npm token with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const registryAuth = "${fakeNpmToken}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "npm_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a GitHub fine-grained PAT with high confidence", () => {
  // `gh` var name avoids the generic keyword rule, so the fine-grained-PAT rule is the only match.
  const findings = scanPatch("src/config.ts", hunk([`const gh = "${fakeGithubPat}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "github_pat");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a Stripe live secret key with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const apiKey = "${fakeStripeKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "stripe_secret_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a SendGrid API key with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const sg = "${fakeSendgridKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sendgrid_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a SendGrid key whose final secret character is a hyphen", () => {
  // Regression: a `\b` terminator would miss a key ending in `-`; the rule uses a
  // negative lookahead so the trailing hyphen still terminates the match.
  const hyphenTail = ["SG.", "a".repeat(22), ".", "b".repeat(42), "-"].join("");
  const findings = scanPatch("src/config.ts", hunk([`const sg = "${hyphenTail}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sendgrid_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a Hugging Face access token with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const hfToken = "${fakeHuggingfaceToken}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "huggingface_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags a generic secret assignment", () => {
  const findings = scanPatch("src/config.ts", hunk([`const apiKey = "${fakeGenericValue}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "generic_secret_assignment");
  assert.equal(findings[0].confidence, "medium");
});

test("scanPatch reports nothing for clean code", () => {
  const findings = scanPatch("src/app.ts", hunk(['const greeting = "hello world";', "export function run() {}"]));
  assert.equal(findings.length, 0);
});

// Regression test for #2454: a real credential split across two added lines via string concatenation evaded
// every RULES regex since neither line's own text contains the full contiguous pattern.
test("scanPatch catches an AWS key split across two adjacent added lines via concatenation (#2454)", () => {
  const findings = scanPatch(
    "src/config.ts",
    hunk([`const part1 = "${awsKeyFragmentA}";`, `const part2 = "${awsKeyFragmentB}";`, "const awsKey = part1 + part2;"]),
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
    hunk([`const key = "${fakeAwsKey}";`, 'const other = "unrelated-string-value";']),
  );
  // The first line already matches directly; its literal must not ALSO be joined into a second, duplicate finding.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
});

test("scanPatch does not join two unrelated short literals into a false positive", () => {
  const findings = scanPatch("src/app.ts", hunk(['const a = "hello";', 'const b = "world";']));
  assert.equal(findings.length, 0);
});

// Regression: an added line whose content starts with `++` renders as `+++...` in the diff. A header-prefix
// guard (even the anchored `+++ `) mistakes it for a `+++ b/file` header and skips it, so a secret on such a
// line is never scanned. Both `++x` (-> `+++x`) and `++ x` (-> `+++ x`) content shapes must be scanned.
for (const content of ['++const key = "AWS_KEY";', '++ const key = "AWS_KEY";']) {
  test(`scanPatch scans an added line whose content starts with ++ (rendered +${content})`, () => {
    const patch = `@@ -1,0 +1,1 @@\n+${content.replace("AWS_KEY", fakeAwsKey)}`;
    const findings = scanPatch("src/config.ts", patch);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "aws_access_key_id");
    assert.equal(findings[0].line, 1);
  });
}

test("scanPatch flags an Anthropic API key with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const anthropicKey = "${fakeAnthropicKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "anthropic_api_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags an Anthropic key whose final body character is a hyphen", () => {
  // Negative lookahead (not `\b`) so a body ending in `-` still matches — same style as SendGrid.
  const hyphenTail = ["sk-ant-", "api03-", "a".repeat(19), "-"].join("");
  const findings = scanPatch("src/config.ts", hunk([`const anthropicKey = "${hyphenTail}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "anthropic_api_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch does not let a no-newline marker skew the line number", () => {
  // `\ No newline at end of file` is not a new-file line; advancing past it would cite the
  // secret one line too high (same class as the iac-misconfig / redos / secret-log regression).
  const patch = [
    "@@ -1,1 +1,2 @@",
    "-const x = 1;",
    "\\ No newline at end of file",
    "+const x = 1;",
    `+const key = "${fakeAwsKey}";`,
  ].join("\n");
  const findings = scanPatch("src/config.ts", patch);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "aws_access_key_id");
  assert.equal(findings[0].line, 2);
});

test("scanPatch flags Slack enterprise and cookie tokens", () => {
  // `xoxe-` (enterprise) and `xoxc-` (cookie) were missing from `xox[baprs]`.
  // Built from fragments so push protection never sees a contiguous secret-shaped literal.
  const enterprise = ["xoxe", "1234567890", "ABCDEFabcdef"].join("-");
  const cookie = ["xoxc", "1234567890", "ABCDEFabcdef"].join("-");
  const entFindings = scanPatch("src/config.ts", hunk([`const slack = "${enterprise}";`]));
  assert.equal(entFindings.length, 1);
  assert.equal(entFindings[0].kind, "slack_token");
  assert.equal(entFindings[0].confidence, "high");
  const cookieFindings = scanPatch("src/config.ts", hunk([`const slack = "${cookie}";`]));
  assert.equal(cookieFindings.length, 1);
  assert.equal(cookieFindings[0].kind, "slack_token");
});

test("scanPatch still flags classic Slack bot tokens", () => {
  const bot = ["xoxb", "1234567890", "ABCDEFabcdef"].join("-");
  const findings = scanPatch("src/config.ts", hunk([`const slack = "${bot}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "slack_token");
});

test("scanPatch flags a DigitalOcean personal access token with high confidence", () => {
  // `dop_v1_` + 64 hex chars. Built from fragments so push protection never sees a contiguous literal.
  const token = ["dop_v1_", "a".repeat(64)].join("");
  const findings = scanPatch("src/config.ts", hunk([`const doToken = "${token}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "digitalocean_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags an uppercase-hex DigitalOcean token", () => {
  // Hex body is case-insensitive (same class as action SHA pins).
  const token = ["dop_v1_", "A".repeat(64)].join("");
  const findings = scanPatch("src/config.ts", hunk([`const doToken = "${token}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "digitalocean_token");
});

test("scanPatch does not flag a truncated DigitalOcean token", () => {
  // Body must be exactly 64 hex chars — shorter prefixes must not false-positive.
  // Variable name avoids the generic `token`/`secret` assignment rule.
  const short = ["dop_v1_", "a".repeat(32)].join("");
  assert.equal(scanPatch("src/config.ts", hunk([`const doCred = "${short}";`])).length, 0);
});

test("scanPatch flags Shopify Admin API and shared-secret tokens", () => {
  // `shpat_` (Admin API access) and `shpss_` (app shared secret) + 32 hex chars.
  const admin = ["shpat_", "a".repeat(32)].join("");
  const shared = ["shpss_", "b".repeat(32)].join("");
  const adminFindings = scanPatch("src/config.ts", hunk([`const shopify = "${admin}";`]));
  assert.equal(adminFindings.length, 1);
  assert.equal(adminFindings[0].kind, "shopify_token");
  assert.equal(adminFindings[0].confidence, "high");
  const sharedFindings = scanPatch("src/config.ts", hunk([`const shopify = "${shared}";`]));
  assert.equal(sharedFindings.length, 1);
  assert.equal(sharedFindings[0].kind, "shopify_token");
});

test("scanPatch does not flag a truncated Shopify token", () => {
  // Body must be exactly 32 hex chars.
  const short = ["shpat_", "a".repeat(16)].join("");
  assert.equal(scanPatch("src/config.ts", hunk([`const shop = "${short}";`])).length, 0);
});

// Fixtures assembled at run time (never a contiguous secret literal in source) so push protection stays quiet.
// `const c = "..."` uses a variable name that the generic keyword-assignment rule ignores, so each string can
// only match its own format-specific rule — the assertion of exactly one finding is meaningful.
const hex = (n) => "a".repeat(n);
const b62 = (n) => "A".repeat(n);

test("scanPatch flags additional high-confidence cloud/SaaS credential formats", () => {
  const cases = [
    ["postman_api_key", "PMAK-" + hex(24) + "-" + hex(34)],
    ["doppler_token", "dp.pt." + b62(43)],
    ["linear_api_key", "lin_api_" + b62(40)],
    ["newrelic_user_key", "NRAK-" + b62(27)],
    ["pypi_upload_token", "pypi-" + "AgEIcHlwaS5vcmc" + b62(50)],
    ["grafana_service_account_token", "glsa_" + b62(32) + "_" + hex(8)],
    ["dynatrace_token", "dt0c01." + b62(24) + "." + b62(64)],
    ["age_secret_key", "AGE-SECRET-KEY-1" + "Q".repeat(58)],
    ["clojars_token", "CLOJARS_" + b62(60)],
    ["square_token", "sq0atp-" + hex(22)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss tokens with the wrong length as the new credential kinds", () => {
  // Each is one char short of its rule's fixed length, plus a bare 40-hex blob (a SHA-1-shaped value that
  // must NOT be mistaken for lin_api_'s 40-char body without the prefix).
  const nearMisses = [
    "lin_api_" + b62(39),
    "CLOJARS_" + b62(59),
    "NRAK-" + b62(26),
    "PMAK-" + hex(24) + "-" + hex(33),
    hex(40),
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});

test("scanPatch flags Stripe test-mode secret and restricted keys", () => {
  // `sk_test_` / `rk_test_` are still credentials — the prior rule only matched `*_live_*`.
  const skTest = ["sk_test_", "abcdefghijklmnop1234567890"].join("");
  const rkTest = ["rk_test_", "abcdefghijklmnop1234567890"].join("");
  const skFindings = scanPatch("src/config.ts", hunk([`const key = "${skTest}";`]));
  assert.equal(skFindings.length, 1);
  assert.equal(skFindings[0].kind, "stripe_secret_key");
  assert.equal(skFindings[0].confidence, "high");
  const rkFindings = scanPatch("src/config.ts", hunk([`const key = "${rkTest}";`]));
  assert.equal(rkFindings.length, 1);
  assert.equal(rkFindings[0].kind, "stripe_secret_key");
});

test("scanPatch still flags Stripe live-mode keys", () => {
  const findings = scanPatch("src/config.ts", hunk([`const key = "${fakeStripeKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "stripe_secret_key");
});

test("scanPatch flags an OpenAI project API key with high confidence", () => {
  const findings = scanPatch("src/config.ts", hunk([`const key = "${fakeOpenAiProjKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "openai_project_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch flags an OpenAI project key whose final body character is a hyphen", () => {
  const key = fakeOpenAiProjKey + "-";
  const findings = scanPatch("src/config.ts", hunk([`const key = "${key}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "openai_project_key");
});

test("scanPatch does not classify Anthropic sk-ant- keys as OpenAI project keys", () => {
  const findings = scanPatch("src/config.ts", hunk([`const key = "${fakeAnthropicKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "anthropic_api_key");
});
