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
const fakeGitlabTokenHyphenTail = "glpat-" + "aBcDeFgHiJkLmNoPqRs-";
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

test("scanPatch flags a GitLab access token whose final token character is a hyphen", () => {
  // Regression: a `\b` terminator misses a token ending in `-`; use a token-alphabet lookahead.
  const findings = scanPatch("src/config.ts", hunk([`const gl = "${fakeGitlabTokenHyphenTail}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "gitlab_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch does not flag a GitLab-shaped run that continues past the expected 20-char token length", () => {
  const overrun = fakeGitlabToken + "X"; // 21 token-alphabet chars after the prefix
  const findings = scanPatch("src/config.ts", hunk([`const gl = "${overrun}";`]));
  assert.equal(
    findings.some((f) => f.kind === "gitlab_token"),
    false,
  );
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

test("scanPatch flags a Notion internal integration secret with high confidence", () => {
  const fakeNotionSecret = "secret_" + "a".repeat(43);
  const findings = scanPatch("src/config.ts", hunk([`const notion = "${fakeNotionSecret}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "notion_integration_secret");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch does not flag a truncated Notion integration secret", () => {
  const truncated = "secret_" + "a".repeat(42);
  const findings = scanPatch("src/config.ts", hunk([`const notion = "${truncated}";`]));
  assert.equal(findings.length, 0);
});

test("scanPatch flags a Mailgun API key with high confidence", () => {
  // Real Mailgun private keys use a 32-char alphanumeric body, not hex-only.
  const fakeMailgunKey = ["key-", "3ax6xnjp29jd6fds4gc373sgvjxteol0"].join("");
  const findings = scanPatch("src/config.ts", hunk([`const mg = "${fakeMailgunKey}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mailgun_api_key");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch does not flag a truncated Mailgun API key", () => {
  const truncated = "key-" + "a".repeat(31);
  const findings = scanPatch("src/config.ts", hunk([`const mg = "${truncated}";`]));
  assert.equal(findings.length, 0);
});

test("scanPatch does not flag a Mailgun-shaped key with an invalid body character", () => {
  const invalid = "key-" + "a".repeat(31) + "_";
  const findings = scanPatch("src/config.ts", hunk([`const mg = "${invalid}";`]));
  assert.equal(findings.length, 0);
});

test("scanPatch flags a Discord bot token with high confidence", () => {
  const fakeDiscordBotToken = ["M", "A".repeat(23), ".", "b".repeat(6), ".", "c".repeat(27)].join("");
  const findings = scanPatch("src/config.ts", hunk([`const discord = "${fakeDiscordBotToken}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "discord_bot_token");
  assert.equal(findings[0].confidence, "high");
});

test("scanPatch does not flag a truncated Discord bot token", () => {
  const truncated = ["M", "A".repeat(23), ".", "b".repeat(6), ".", "c".repeat(26)].join("");
  const findings = scanPatch("src/config.ts", hunk([`const discord = "${truncated}";`]));
  assert.equal(findings.length, 0);
});

test("scanPatch does not classify a Discord bot token as a webhook URL", () => {
  const fakeDiscordBotToken = ["N", "B".repeat(23), ".", "d".repeat(6), ".", "e".repeat(27)].join("");
  const findings = scanPatch("src/config.ts", hunk([`const discord = "${fakeDiscordBotToken}";`]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "discord_bot_token");
  assert.equal(findings.some((f) => f.kind === "discord_webhook_url"), false);
});

test("scanPatch flags Twilio Account and API Key SIDs with high confidence", () => {
  const fakeTwilioAccountSid = "AC" + "a".repeat(32);
  const fakeTwilioApiKeySid = "SK" + "b".repeat(32);
  const accountFindings = scanPatch("src/config.ts", hunk([`const sid = "${fakeTwilioAccountSid}";`]));
  assert.equal(accountFindings.length, 1);
  assert.equal(accountFindings[0].kind, "twilio_account_sid");
  assert.equal(accountFindings[0].confidence, "high");

  const keyFindings = scanPatch("src/config.ts", hunk([`const apiKey = "${fakeTwilioApiKeySid}";`]));
  assert.equal(keyFindings.length, 1);
  assert.equal(keyFindings[0].kind, "twilio_api_key_sid");
  assert.equal(keyFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Twilio SIDs or identifier continuation past 32 hex chars", () => {
  const truncated = "AC" + "a".repeat(31);
  assert.equal(scanPatch("src/config.ts", hunk([`const sid = "${truncated}";`])).length, 0);
  const hexOverrun = "AC" + "a".repeat(32) + "f";
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sid = "${hexOverrun}";`])).some((f) => f.kind === "twilio_account_sid"),
    false,
  );
  const nonHexTail = "AC" + "a".repeat(32) + "z";
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sid = "${nonHexTail}";`])).some((f) => f.kind === "twilio_account_sid"),
    false,
  );
  const skNonHexTail = "SK" + "b".repeat(32) + "z";
  assert.equal(
    scanPatch("src/config.ts", hunk([`const key = "${skNonHexTail}";`])).some((f) => f.kind === "twilio_api_key_sid"),
    false,
  );
});

test("scanPatch flags Resend and Mapbox secret tokens with high confidence", () => {
  const fakeResendKey = "re_" + "a".repeat(32);
  const resendFindings = scanPatch("src/config.ts", hunk([`const resend = "${fakeResendKey}";`]));
  assert.equal(resendFindings.length, 1);
  assert.equal(resendFindings[0].kind, "resend_api_key");
  assert.equal(resendFindings[0].confidence, "high");

  const fakeMapboxSecret = ["sk.", "eyJ", "a".repeat(24)].join("");
  const mapboxFindings = scanPatch("src/config.ts", hunk([`const mapbox = "${fakeMapboxSecret}";`]));
  assert.equal(mapboxFindings.length, 1);
  assert.equal(mapboxFindings[0].kind, "mapbox_secret_token");
  assert.equal(mapboxFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Resend keys or classify Mapbox secrets as Stripe keys", () => {
  const truncatedResend = "re_" + "a".repeat(23);
  assert.equal(scanPatch("src/config.ts", hunk([`const resend = "${truncatedResend}";`])).length, 0);

  const fakeMapboxSecret = ["sk.", "eyJ", "c".repeat(24)].join("");
  const findings = scanPatch("src/config.ts", hunk([`const mapbox = "${fakeMapboxSecret}";`]));
  assert.equal(findings.some((f) => f.kind === "stripe_secret_key"), false);
  assert.equal(findings.some((f) => f.kind === "mapbox_secret_token"), true);
});

test("scanPatch does not flag truncated Mapbox secrets or public pk tokens", () => {
  const truncated = ["sk.", "eyJ", "a".repeat(23)].join("");
  assert.equal(scanPatch("src/config.ts", hunk([`const mapbox = "${truncated}";`])).length, 0);
  const publicToken = ["pk.", "eyJ", "b".repeat(24)].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const mapbox = "${publicToken}";`])).some((f) => f.kind === "mapbox_secret_token"),
    false,
  );
});

test("scanPatch flags Cohere and Intercom access tokens with high confidence", () => {
  const fakeCohereKey = "co_" + "a".repeat(48);
  const cohereFindings = scanPatch("src/config.ts", hunk([`const cohere = "${fakeCohereKey}";`]));
  assert.equal(cohereFindings.length, 1);
  assert.equal(cohereFindings[0].kind, "cohere_api_key");
  assert.equal(cohereFindings[0].confidence, "high");

  const fakeIntercomToken = "dG9rOm" + "a".repeat(30);
  const intercomFindings = scanPatch("src/config.ts", hunk([`const intercom = "${fakeIntercomToken}";`]));
  assert.equal(intercomFindings.length, 1);
  assert.equal(intercomFindings[0].kind, "intercom_access_token");
  assert.equal(intercomFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Cohere/Intercom tokens or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const cohere = "co_${"a".repeat(47)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const cohere = "co_${"a".repeat(48)}_suffix";`])).some((f) => f.kind === "cohere_api_key"),
    false,
  );
  assert.equal(scanPatch("src/config.ts", hunk([`const intercom = "dG9rOm${"a".repeat(29)}";`])).length, 0);
});

test("scanPatch flags Together AI and Fireworks API keys with high confidence", () => {
  const fakeTogetherKey = "together_" + "a".repeat(16);
  const togetherFindings = scanPatch("src/config.ts", hunk([`const together = "${fakeTogetherKey}";`]));
  assert.equal(togetherFindings.length, 1);
  assert.equal(togetherFindings[0].kind, "together_api_key");
  assert.equal(togetherFindings[0].confidence, "high");

  const fakeFireworksKey = "fw_" + "a".repeat(20);
  const fireworksFindings = scanPatch("src/config.ts", hunk([`const fireworks = "${fakeFireworksKey}";`]));
  assert.equal(fireworksFindings.length, 1);
  assert.equal(fireworksFindings[0].kind, "fireworks_api_key");
  assert.equal(fireworksFindings[0].confidence, "high");

  const fakeFirePassKey = "fpk_" + "b".repeat(20);
  const firePassFindings = scanPatch("src/config.ts", hunk([`const firepass = "${fakeFirePassKey}";`]));
  assert.equal(firePassFindings.length, 1);
  assert.equal(firePassFindings[0].kind, "fireworks_api_key");
  assert.equal(firePassFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Together/Fireworks keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const together = "together_${"a".repeat(15)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const together = "together_${"a".repeat(16)}_suffix";`])).some((f) => f.kind === "together_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const fireworks = "fw_${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const fireworks = "fw_${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "fireworks_api_key"),
    false,
  );
  assert.equal(scanPatch("src/config.ts", hunk([`const firepass = "fpk_${"b".repeat(19)}";`])).length, 0);
});

test("scanPatch flags Pinecone and Tavily API keys with high confidence", () => {
  const fakePineconeKey = ["pcsk_", "T5Afk6", "_", "a".repeat(63)].join("");
  const pineconeFindings = scanPatch("src/config.ts", hunk([`const pinecone = "${fakePineconeKey}";`]));
  assert.equal(pineconeFindings.length, 1);
  assert.equal(pineconeFindings[0].kind, "pinecone_api_key");
  assert.equal(pineconeFindings[0].confidence, "high");

  const fakeTavilyKey = "tvly-" + "a".repeat(16);
  const tavilyFindings = scanPatch("src/config.ts", hunk([`const tavily = "${fakeTavilyKey}";`]));
  assert.equal(tavilyFindings.length, 1);
  assert.equal(tavilyFindings[0].kind, "tavily_api_key");
  assert.equal(tavilyFindings[0].confidence, "high");
});

test("scanPatch does not flag malformed Pinecone/Tavily keys or identifier continuation", () => {
  const shortLabel = ["pcsk_", "abcd", "_", "a".repeat(63)].join("");
  assert.equal(scanPatch("src/config.ts", hunk([`const pinecone = "${shortLabel}";`])).length, 0);
  const shortSecret = ["pcsk_", "T5Afk6", "_", "a".repeat(62)].join("");
  assert.equal(scanPatch("src/config.ts", hunk([`const pinecone = "${shortSecret}";`])).length, 0);
  const pineconeEmbedded = ["pcsk_", "T5Afk6", "_", "a".repeat(63), "X"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const pinecone = "${pineconeEmbedded}";`])).some((f) => f.kind === "pinecone_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const tavily = "tvly-${"a".repeat(15)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const tavily = "tvly-${"a".repeat(16)}_suffix";`])).some((f) => f.kind === "tavily_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const tavily = "tvly-${"a".repeat(16)}-suffix";`])).some((f) => f.kind === "tavily_api_key"),
    false,
  );
});

test("scanPatch flags Voyage AI and Firecrawl API keys with high confidence", () => {
  const fakeVoyagePlatform = "pa-" + "a".repeat(20);
  const voyagePlatformFindings = scanPatch("src/config.ts", hunk([`const voyage = "${fakeVoyagePlatform}";`]));
  assert.equal(voyagePlatformFindings.length, 1);
  assert.equal(voyagePlatformFindings[0].kind, "voyage_api_key");
  assert.equal(voyagePlatformFindings[0].confidence, "high");

  const fakeVoyageAtlas = "al-" + "b".repeat(20);
  const voyageAtlasFindings = scanPatch("src/config.ts", hunk([`const atlas = "${fakeVoyageAtlas}";`]));
  assert.equal(voyageAtlasFindings.length, 1);
  assert.equal(voyageAtlasFindings[0].kind, "voyage_api_key");
  assert.equal(voyageAtlasFindings[0].confidence, "high");

  const fakeFirecrawlKey = "fc-" + "c".repeat(16);
  const firecrawlFindings = scanPatch("src/config.ts", hunk([`const firecrawl = "${fakeFirecrawlKey}";`]));
  assert.equal(firecrawlFindings.length, 1);
  assert.equal(firecrawlFindings[0].kind, "firecrawl_api_key");
  assert.equal(firecrawlFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Voyage/Firecrawl keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const voyage = "pa-${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const voyage = "pa-${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "voyage_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const voyage = "al-${"b".repeat(20)}_suffix";`])).some((f) => f.kind === "voyage_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const firecrawl = "fc-${"c".repeat(15)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const firecrawl = "fc-${"c".repeat(16)}-suffix";`])).some((f) => f.kind === "firecrawl_api_key"),
    false,
  );
});

test("scanPatch flags Browserbase and Modal API tokens with high confidence", () => {
  const fakeBrowserbaseKey = "bb_" + "a".repeat(20);
  const browserbaseFindings = scanPatch("src/config.ts", hunk([`const browserbase = "${fakeBrowserbaseKey}";`]));
  assert.equal(browserbaseFindings.length, 1);
  assert.equal(browserbaseFindings[0].kind, "browserbase_api_key");
  assert.equal(browserbaseFindings[0].confidence, "high");

  const fakeModalTokenId = "ak-" + "b".repeat(20);
  const modalIdFindings = scanPatch("src/config.ts", hunk([`const modalId = "${fakeModalTokenId}";`]));
  assert.equal(modalIdFindings.length, 1);
  assert.equal(modalIdFindings[0].kind, "modal_token");
  assert.equal(modalIdFindings[0].confidence, "high");

  const fakeModalTokenSecret = "as-" + "c".repeat(20);
  const modalSecretFindings = scanPatch("src/config.ts", hunk([`const modalSecret = "${fakeModalTokenSecret}";`]));
  assert.equal(modalSecretFindings.length, 1);
  assert.equal(modalSecretFindings[0].kind, "modal_token");
  assert.equal(modalSecretFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Browserbase/Modal tokens or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const browserbase = "bb_${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const browserbase = "bb_${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "browserbase_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const browserbase = "bb_${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "browserbase_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const modalId = "ak-${"b".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const modalId = "ak-${"b".repeat(20)}-suffix";`])).some((f) => f.kind === "modal_token"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const modalSecret = "as-${"c".repeat(20)}_suffix";`])).some((f) => f.kind === "modal_token"),
    false,
  );
});

test("scanPatch flags fal.ai and Weights & Biases API keys with high confidence", () => {
  const fakeFalKey = "fal_sk_" + "a".repeat(20);
  const falFindings = scanPatch("src/config.ts", hunk([`const fal = "${fakeFalKey}";`]));
  assert.equal(falFindings.length, 1);
  assert.equal(falFindings[0].kind, "fal_api_key");
  assert.equal(falFindings[0].confidence, "high");

  const fakeWandbKey = "wandb_v1_" + "a".repeat(77);
  const wandbFindings = scanPatch("src/config.ts", hunk([`const wandb = "${fakeWandbKey}";`]));
  assert.equal(wandbFindings.length, 1);
  assert.equal(wandbFindings[0].kind, "wandb_api_key");
  assert.equal(wandbFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated fal/W&B keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const fal = "fal_sk_${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const fal = "fal_sk_${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "fal_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const fal = "fal_sk_${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "fal_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const wandb = "wandb_v1_${"a".repeat(76)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const wandb = "wandb_v1_${"a".repeat(77)}X";`])).some((f) => f.kind === "wandb_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const wandb = "wandb_v1_${"a".repeat(77)}_suffix";`])).some((f) => f.kind === "wandb_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const wandb = "wandb_v1_${"a".repeat(77)}-suffix";`])).some((f) => f.kind === "wandb_api_key"),
    false,
  );
});

test("scanPatch flags xAI and Deepgram API keys with high confidence", () => {
  const fakeXaiKey = "xai-" + "a".repeat(16);
  const xaiFindings = scanPatch("src/config.ts", hunk([`const xai = "${fakeXaiKey}";`]));
  assert.equal(xaiFindings.length, 1);
  assert.equal(xaiFindings[0].kind, "xai_api_key");
  assert.equal(xaiFindings[0].confidence, "high");

  const fakeDeepgramKey = ["dg.", "b".repeat(20)].join("");
  const deepgramFindings = scanPatch("src/config.ts", hunk([`const deepgram = "${fakeDeepgramKey}";`]));
  assert.equal(deepgramFindings.length, 1);
  assert.equal(deepgramFindings[0].kind, "deepgram_api_key");
  assert.equal(deepgramFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated xAI/Deepgram keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const xai = "xai-${"a".repeat(15)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const xai = "xai-${"a".repeat(16)}_suffix";`])).some((f) => f.kind === "xai_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const xai = "xai-${"a".repeat(16)}-suffix";`])).some((f) => f.kind === "xai_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const deepgram = "dg.${"b".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const deepgram = "dg.${"b".repeat(20)}_suffix";`])).some((f) => f.kind === "deepgram_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const deepgram = "dg.${"b".repeat(20)}-suffix";`])).some((f) => f.kind === "deepgram_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const deepgram = "dg.${"b".repeat(20)}.suffix";`])).some((f) => f.kind === "deepgram_api_key"),
    false,
  );
});

test("scanPatch flags Cartesia and Apify API tokens with high confidence", () => {
  const fakeCartesiaKey = "sk_car_" + "a".repeat(20);
  const cartesiaFindings = scanPatch("src/config.ts", hunk([`const cartesia = "${fakeCartesiaKey}";`]));
  assert.equal(cartesiaFindings.length, 1);
  assert.equal(cartesiaFindings[0].kind, "cartesia_api_key");
  assert.equal(cartesiaFindings[0].confidence, "high");

  const fakeCartesiaAdmin = "sk_car_admin_" + "b".repeat(20);
  const cartesiaAdminFindings = scanPatch("src/config.ts", hunk([`const cartesiaAdmin = "${fakeCartesiaAdmin}";`]));
  assert.equal(cartesiaAdminFindings.length, 1);
  assert.equal(cartesiaAdminFindings[0].kind, "cartesia_api_key");
  assert.equal(cartesiaAdminFindings[0].confidence, "high");

  const fakeApifyToken = "apify_api_" + "c".repeat(20);
  const apifyFindings = scanPatch("src/config.ts", hunk([`const apify = "${fakeApifyToken}";`]));
  assert.equal(apifyFindings.length, 1);
  assert.equal(apifyFindings[0].kind, "apify_api_token");
  assert.equal(apifyFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Cartesia/Apify tokens or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const cartesia = "sk_car_${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const cartesia = "sk_car_${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "cartesia_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const cartesia = "sk_car_${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "cartesia_api_key"),
    false,
  );
  assert.equal(scanPatch("src/config.ts", hunk([`const cartesiaAdmin = "sk_car_admin_${"b".repeat(19)}";`])).length, 0);

  assert.equal(scanPatch("src/config.ts", hunk([`const apify = "apify_api_${"c".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const apify = "apify_api_${"c".repeat(20)}_suffix";`])).some((f) => f.kind === "apify_api_token"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const apify = "apify_api_${"c".repeat(20)}-suffix";`])).some((f) => f.kind === "apify_api_token"),
    false,
  );
});

test("scanPatch flags Baseten federated and Laminar API keys with high confidence", () => {
  const fakeBasetenKey = ["sky_", "sCqhBwEy4kPd", ".", "a".repeat(20)].join("");
  const basetenFindings = scanPatch("src/config.ts", hunk([`const baseten = "${fakeBasetenKey}";`]));
  assert.equal(basetenFindings.length, 1);
  assert.equal(basetenFindings[0].kind, "baseten_federated_api_key");
  assert.equal(basetenFindings[0].confidence, "high");

  for (const prefixLen of [9, 16]) {
    const boundaryKey = ["sky_", "a".repeat(prefixLen), ".", "b".repeat(20)].join("");
    const boundaryFindings = scanPatch("src/config.ts", hunk([`const baseten = "${boundaryKey}";`]));
    assert.equal(boundaryFindings.length, 1, `expected match for ${prefixLen}-char Baseten prefix`);
    assert.equal(boundaryFindings[0].kind, "baseten_federated_api_key");
  }

  const fakeLaminarKey = "lmnr_" + "b".repeat(20);
  const laminarFindings = scanPatch("src/config.ts", hunk([`const laminar = "${fakeLaminarKey}";`]));
  assert.equal(laminarFindings.length, 1);
  assert.equal(laminarFindings[0].kind, "laminar_api_key");
  assert.equal(laminarFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Baseten/Laminar keys or identifier continuation", () => {
  for (const prefixLen of [8, 17]) {
    const shortPrefixKey = ["sky_", "a".repeat(prefixLen), ".", "b".repeat(20)].join("");
    assert.equal(
      scanPatch("src/config.ts", hunk([`const baseten = "${shortPrefixKey}";`])).some((f) => f.kind === "baseten_federated_api_key"),
      false,
      `expected no match for ${prefixLen}-char Baseten prefix`,
    );
  }
  const shortBasetenSecret = ["sky_", "sCqhBwEy4kPd", ".", "a".repeat(19)].join("");
  assert.equal(scanPatch("src/config.ts", hunk([`const baseten = "${shortBasetenSecret}";`])).length, 0);
  const basetenDotSuffix = ["sky_", "sCqhBwEy4kPd", ".", "a".repeat(20), ".suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const baseten = "${basetenDotSuffix}";`])).some((f) => f.kind === "baseten_federated_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const laminar = "lmnr_${"b".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const laminar = "lmnr_${"b".repeat(20)}_suffix";`])).some((f) => f.kind === "laminar_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const laminar = "lmnr_${"b".repeat(20)}-suffix";`])).some((f) => f.kind === "laminar_api_key"),
    false,
  );
});

test("scanPatch flags Exa and Mem0 API keys with high confidence", () => {
  const fakeExaKey = "exa_" + "x".repeat(20);
  const exaFindings = scanPatch("src/config.ts", hunk([`const exa = "${fakeExaKey}";`]));
  assert.equal(exaFindings.length, 1);
  assert.equal(exaFindings[0].kind, "exa_api_key");
  assert.equal(exaFindings[0].confidence, "high");

  const fakeMem0PlatformKey = "m0-" + "a".repeat(20);
  const mem0PlatformFindings = scanPatch("src/config.ts", hunk([`const mem0 = "${fakeMem0PlatformKey}";`]));
  assert.equal(mem0PlatformFindings.length, 1);
  assert.equal(mem0PlatformFindings[0].kind, "mem0_api_key");
  assert.equal(mem0PlatformFindings[0].confidence, "high");

  const fakeMem0SelfHostedKey = "m0sk_" + "b".repeat(20);
  const mem0SelfHostedFindings = scanPatch("src/config.ts", hunk([`const mem0Local = "${fakeMem0SelfHostedKey}";`]));
  assert.equal(mem0SelfHostedFindings.length, 1);
  assert.equal(mem0SelfHostedFindings[0].kind, "mem0_api_key");
  assert.equal(mem0SelfHostedFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Exa/Mem0 keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const exa = "exa_${"x".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const exa = "exa_${"x".repeat(20)}_suffix";`])).some((f) => f.kind === "exa_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const exa = "exa_${"x".repeat(20)}-suffix";`])).some((f) => f.kind === "exa_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const mem0 = "m0-${"a".repeat(19)}";`])).length, 0);
  assert.equal(scanPatch("src/config.ts", hunk([`const mem0Local = "m0sk_${"b".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const mem0 = "m0-${"a".repeat(20)}.suffix";`])).some((f) => f.kind === "mem0_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const mem0Local = "m0sk_${"b".repeat(20)}.suffix";`])).some((f) => f.kind === "mem0_api_key"),
    false,
  );
});

test("scanPatch flags Braintrust and ScrapeGraphAI API keys with high confidence", () => {
  const fakeBraintrustToken = "bt-st-" + "a".repeat(20);
  const braintrustFindings = scanPatch("src/config.ts", hunk([`const bt = "${fakeBraintrustToken}";`]));
  assert.equal(braintrustFindings.length, 1);
  assert.equal(braintrustFindings[0].kind, "braintrust_service_token");
  assert.equal(braintrustFindings[0].confidence, "high");

  const fakeScrapeGraphKey = ["sgai-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901"].join("");
  const scrapeGraphFindings = scanPatch("src/config.ts", hunk([`const sgai = "${fakeScrapeGraphKey}";`]));
  assert.equal(scrapeGraphFindings.length, 1);
  assert.equal(scrapeGraphFindings[0].kind, "scrapegraphai_api_key");
  assert.equal(scrapeGraphFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Braintrust/ScrapeGraphAI keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const bt = "bt-st-${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const bt = "bt-st-${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "braintrust_service_token"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const bt = "bt-st-${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "braintrust_service_token"),
    false,
  );

  const shortScrapeGraphKey = ["sgai-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "01234567890"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sgai = "${shortScrapeGraphKey}";`])).some((f) => f.kind === "scrapegraphai_api_key"),
    false,
  );
  const scrapeGraphSuffixKey = ["sgai-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901", "-suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sgai = "${scrapeGraphSuffixKey}";`])).some((f) => f.kind === "scrapegraphai_api_key"),
    false,
  );
});

test("scanPatch flags Langfuse public and Hyperbolic API keys with high confidence", () => {
  const fakeLangfusePublicKey = "pk-lf-" + "a".repeat(20);
  const langfuseFindings = scanPatch("src/config.ts", hunk([`const langfuse = "${fakeLangfusePublicKey}";`]));
  assert.equal(langfuseFindings.length, 1);
  assert.equal(langfuseFindings[0].kind, "langfuse_public_key");
  assert.equal(langfuseFindings[0].confidence, "high");

  const fakeHyperbolicKey = "hb_" + "b".repeat(20);
  const hyperbolicFindings = scanPatch("src/config.ts", hunk([`const hyperbolic = "${fakeHyperbolicKey}";`]));
  assert.equal(hyperbolicFindings.length, 1);
  assert.equal(hyperbolicFindings[0].kind, "hyperbolic_api_key");
  assert.equal(hyperbolicFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Langfuse/Hyperbolic keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const langfuse = "pk-lf-${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const langfuse = "pk-lf-${"a".repeat(20)}.suffix";`])).some((f) => f.kind === "langfuse_public_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const hyperbolic = "hb_${"b".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const hyperbolic = "hb_${"b".repeat(20)}_suffix";`])).some((f) => f.kind === "hyperbolic_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const hyperbolic = "hb_${"b".repeat(20)}-suffix";`])).some((f) => f.kind === "hyperbolic_api_key"),
    false,
  );
});

test("scanPatch flags Gladia and WorkOS legacy API keys with high confidence", () => {
  const fakeGladiaKey = "gla_" + "a".repeat(20);
  const gladiaFindings = scanPatch("src/config.ts", hunk([`const gladia = "${fakeGladiaKey}";`]));
  assert.equal(gladiaFindings.length, 1);
  assert.equal(gladiaFindings[0].kind, "gladia_api_key");
  assert.equal(gladiaFindings[0].confidence, "high");

  const fakeWorkosKey = "wos_api_key_" + "b".repeat(20);
  const workosFindings = scanPatch("src/config.ts", hunk([`const workos = "${fakeWorkosKey}";`]));
  assert.equal(workosFindings.length, 1);
  assert.equal(workosFindings[0].kind, "workos_legacy_api_key");
  assert.equal(workosFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Gladia/WorkOS keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const gladia = "gla_${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const gladia = "gla_${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "gladia_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const gladia = "gla_${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "gladia_api_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const workos = "wos_api_key_${"b".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const workos = "wos_api_key_${"b".repeat(20)}_suffix";`])).some((f) => f.kind === "workos_legacy_api_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const workos = "wos_api_key_${"b".repeat(20)}-suffix";`])).some((f) => f.kind === "workos_legacy_api_key"),
    false,
  );
});

test("scanPatch flags MiniMax Token Plan and pay-per-token API keys with high confidence", () => {
  const fakeMinimaxCpKey = "sk-cp-" + "a".repeat(20);
  const minimaxCpFindings = scanPatch("src/config.ts", hunk([`const minimax = "${fakeMinimaxCpKey}";`]));
  assert.equal(minimaxCpFindings.length, 1);
  assert.equal(minimaxCpFindings[0].kind, "minimax_token_plan_key");
  assert.equal(minimaxCpFindings[0].confidence, "high");

  const fakeMinimaxApiKey = "sk-api-" + "b".repeat(20);
  const minimaxApiFindings = scanPatch("src/config.ts", hunk([`const minimax = "${fakeMinimaxApiKey}";`]));
  assert.equal(minimaxApiFindings.length, 1);
  assert.equal(minimaxApiFindings[0].kind, "minimax_pay_per_token_key");
  assert.equal(minimaxApiFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated MiniMax keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const minimax = "sk-cp-${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const minimax = "sk-cp-${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "minimax_token_plan_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const minimax = "sk-cp-${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "minimax_token_plan_key"),
    false,
  );

  assert.equal(scanPatch("src/config.ts", hunk([`const minimax = "sk-api-${"b".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const minimax = "sk-api-${"b".repeat(20)}_suffix";`])).some((f) => f.kind === "minimax_pay_per_token_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const minimax = "sk-api-${"b".repeat(20)}-suffix";`])).some((f) => f.kind === "minimax_pay_per_token_key"),
    false,
  );
});

test("scanPatch flags Axiom API and personal access tokens with high confidence", () => {
  const fakeAxiomApiToken = ["xaat-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901"].join("");
  const axiomApiFindings = scanPatch("src/config.ts", hunk([`const axiom = "${fakeAxiomApiToken}";`]));
  assert.equal(axiomApiFindings.length, 1);
  assert.equal(axiomApiFindings[0].kind, "axiom_api_token");
  assert.equal(axiomApiFindings[0].confidence, "high");

  const fakeAxiomPat = ["xapt-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901"].join("");
  const axiomPatFindings = scanPatch("src/config.ts", hunk([`const axiom = "${fakeAxiomPat}";`]));
  assert.equal(axiomPatFindings.length, 1);
  assert.equal(axiomPatFindings[0].kind, "axiom_personal_token");
  assert.equal(axiomPatFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Axiom tokens or identifier continuation", () => {
  const shortAxiomApiToken = ["xaat-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "01234567890"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${shortAxiomApiToken}";`])).some((f) => f.kind === "axiom_api_token"),
    false,
  );
  const axiomApiSuffixToken = ["xaat-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901", "-suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${axiomApiSuffixToken}";`])).some((f) => f.kind === "axiom_api_token"),
    false,
  );
  const axiomApiUnderscoreToken = ["xaat-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901", "_suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${axiomApiUnderscoreToken}";`])).some((f) => f.kind === "axiom_api_token"),
    false,
  );
  const axiomApiAlphaSuffixToken = ["xaat-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901", "z"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${axiomApiAlphaSuffixToken}";`])).some((f) => f.kind === "axiom_api_token"),
    false,
  );

  const shortAxiomPat = ["xapt-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "01234567890"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${shortAxiomPat}";`])).some((f) => f.kind === "axiom_personal_token"),
    false,
  );
  const axiomPatSuffixToken = ["xapt-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901", "-suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${axiomPatSuffixToken}";`])).some((f) => f.kind === "axiom_personal_token"),
    false,
  );
  const axiomPatUnderscoreToken = ["xapt-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901", "_suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${axiomPatUnderscoreToken}";`])).some((f) => f.kind === "axiom_personal_token"),
    false,
  );
  const axiomPatAlphaSuffixToken = ["xapt-", "01234567", "-", "0123", "-", "4567", "-", "8901", "-", "012345678901", "z"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const axiom = "${axiomPatAlphaSuffixToken}";`])).some((f) => f.kind === "axiom_personal_token"),
    false,
  );
});

test("scanPatch flags Knock service and Sourcegraph access tokens with high confidence", () => {
  const fakeKnockToken = "knock_st_" + "a".repeat(20);
  const knockFindings = scanPatch("src/config.ts", hunk([`const knock = "${fakeKnockToken}";`]));
  assert.equal(knockFindings.length, 1);
  assert.equal(knockFindings[0].kind, "knock_service_token");
  assert.equal(knockFindings[0].confidence, "high");

  const fakeSourcegraphToken = "sgp_" + hex(16) + "_" + hex(40);
  const sourcegraphFindings = scanPatch("src/config.ts", hunk([`const sg = "${fakeSourcegraphToken}";`]));
  assert.equal(sourcegraphFindings.length, 1);
  assert.equal(sourcegraphFindings[0].kind, "sourcegraph_access_token");
  assert.equal(sourcegraphFindings[0].confidence, "high");
});

test("scanPatch does not flag truncated Knock/Sourcegraph tokens or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const knock = "knock_st_${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const knock = "knock_st_${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "knock_service_token"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const knock = "knock_st_${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "knock_service_token"),
    false,
  );

  const shortSourcegraphToken = "sgp_" + hex(16) + "_" + hex(39);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sg = "${shortSourcegraphToken}";`])).some((f) => f.kind === "sourcegraph_access_token"),
    false,
  );
  const sourcegraphSuffixToken = "sgp_" + hex(16) + "_" + hex(40) + "-suffix";
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sg = "${sourcegraphSuffixToken}";`])).some((f) => f.kind === "sourcegraph_access_token"),
    false,
  );
  const sourcegraphUnderscoreToken = "sgp_" + hex(16) + "_" + hex(40) + "_suffix";
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sg = "${sourcegraphUnderscoreToken}";`])).some((f) => f.kind === "sourcegraph_access_token"),
    false,
  );
  const sourcegraphAlphaSuffixToken = "sgp_" + hex(16) + "_" + hex(40) + "z";
  assert.equal(
    scanPatch("src/config.ts", hunk([`const sg = "${sourcegraphAlphaSuffixToken}";`])).some((f) => f.kind === "sourcegraph_access_token"),
    false,
  );
});

test("scanPatch flags Statsig server secret and Paddle API keys with high confidence", () => {
  const fakeStatsigKey = "secret-" + "a".repeat(20);
  const statsigFindings = scanPatch("src/config.ts", hunk([`const statsig = "${fakeStatsigKey}";`]));
  assert.equal(statsigFindings.length, 1);
  assert.equal(statsigFindings[0].kind, "statsig_server_secret_key");
  assert.equal(statsigFindings[0].confidence, "high");

  const fakePaddleKey = ["pdl_", "live", "_apikey_", "a".repeat(26), "_", "b".repeat(22), "_", "c".repeat(3)].join("");
  const paddleFindings = scanPatch("src/config.ts", hunk([`const paddle = "${fakePaddleKey}";`]));
  assert.equal(paddleFindings.length, 1);
  assert.equal(paddleFindings[0].kind, "paddle_api_key");
  assert.equal(paddleFindings[0].confidence, "high");

  const fakePaddleKeyMixed = ["pdl_", "sdbx", "_apikey_", "A".repeat(26), "_", "b".repeat(22), "_", "c".repeat(3)].join("");
  const paddleMixedFindings = scanPatch("src/config.ts", hunk([`const paddle = "${fakePaddleKeyMixed}";`]));
  assert.equal(paddleMixedFindings.length, 1);
  assert.equal(paddleMixedFindings[0].kind, "paddle_api_key");
});

test("scanPatch does not flag truncated Statsig/Paddle keys or identifier continuation", () => {
  assert.equal(scanPatch("src/config.ts", hunk([`const statsig = "secret-${"a".repeat(19)}";`])).length, 0);
  assert.equal(
    scanPatch("src/config.ts", hunk([`const statsig = "secret-${"a".repeat(20)}_suffix";`])).some((f) => f.kind === "statsig_server_secret_key"),
    false,
  );
  assert.equal(
    scanPatch("src/config.ts", hunk([`const statsig = "secret-${"a".repeat(20)}-suffix";`])).some((f) => f.kind === "statsig_server_secret_key"),
    false,
  );

  const shortPaddleKey = ["pdl_", "live", "_apikey_", "a".repeat(25), "_", "b".repeat(22), "_", "c".repeat(3)].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const paddle = "${shortPaddleKey}";`])).some((f) => f.kind === "paddle_api_key"),
    false,
  );
  const paddleSuffixKey = ["pdl_", "live", "_apikey_", "a".repeat(26), "_", "b".repeat(22), "_", "c".repeat(3), "-suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const paddle = "${paddleSuffixKey}";`])).some((f) => f.kind === "paddle_api_key"),
    false,
  );
  const paddleUnderscoreKey = ["pdl_", "live", "_apikey_", "a".repeat(26), "_", "b".repeat(22), "_", "c".repeat(3), "_suffix"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const paddle = "${paddleUnderscoreKey}";`])).some((f) => f.kind === "paddle_api_key"),
    false,
  );
  const paddleAlphaSuffixKey = ["pdl_", "live", "_apikey_", "a".repeat(26), "_", "b".repeat(22), "_", "c".repeat(3), "z"].join("");
  assert.equal(
    scanPatch("src/config.ts", hunk([`const paddle = "${paddleAlphaSuffixKey}";`])).some((f) => f.kind === "paddle_api_key"),
    false,
  );
});

test("scanPatch flags additional high-confidence SaaS/cloud/CI credential formats", () => {
  const cases = [
    ["google_oauth_client_secret", "GOCSPX-" + b62(28)],
    ["stripe_webhook_secret", "whsec_" + b62(32)],
    ["databricks_pat", "dapi" + hex(32)],
    ["telegram_bot_token", "1234567890" + ":" + b62(35)],
    ["rubygems_api_key", "rubygems_" + hex(48)],
    ["terraform_cloud_token", b62(14) + ".atlasv1." + b62(60)],
    ["planetscale_password", "pscale_pw_" + b62(32)],
    ["planetscale_token", "pscale_tkn_" + b62(32)],
    ["prefect_api_key", "pnu_" + b62(36)],
    ["vault_service_token", "hvs." + b62(24)],
    ["mailchimp_api_key", hex(32) + "-us12"],
    ["slack_webhook_url", "https://hooks.slack.com/services/T" + b62(8) + "/B" + b62(8) + "/" + b62(24)],
    ["airtable_pat", "pat" + b62(14) + "." + hex(64)],
    ["gitlab_pipeline_trigger_token", "glptt-" + hex(40)],
    ["gitlab_runner_token", "glrt-" + b62(20)],
    ["shippo_api_token", "shippo_live_" + hex(40)],
    ["flyio_token", "fo1_" + b62(43)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss variants of the new SaaS/cloud credential formats", () => {
  // One char short of the fixed length (or missing a required disambiguator) must produce no finding.
  const nearMisses = [
    "GOCSPX-" + b62(27),
    "dapi" + hex(31),
    "rubygems_" + hex(47),
    "pnu_" + b62(35),
    hex(32) + "-us", // Mailchimp shape without the datacenter digits
    "glptt-" + hex(39),
    "fo1_" + b62(42),
    "airtable_" + b62(20), // no Airtable pat<id>.<hex> shape
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});

test("scanPatch flags additional high-confidence AI-provider and SaaS/CI credential formats", () => {
  const cases = [
    // The base64url-body formats deliberately END IN `-` to prove the rule terminates on a
    // negative-lookahead, not `\b` (a `\b` terminator silently misses a real token ending in `-`).
    ["dropbox_token", "sl." + b62(139) + "-"],
    ["jfrog_api_key", "AKCp8" + b62(70)],
    ["duffel_token", "duffel_test_" + b62(42) + "-"],
    ["easypost_key", "EZAK" + b62(54)],
    ["frameio_token", "fio-u-" + b62(63) + "-"],
    ["contentful_token", "CFPAT-" + b62(42) + "-"],
    ["sonarqube_token", "sqp_" + hex(40)],
    ["pulumi_token", "pul-" + hex(40)],
    ["adafruit_io_key", "aio_" + b62(28)],
    ["readme_api_key", "rdme_" + hex(70)],
    ["typeform_token", "tfp_" + b62(40)],
    ["sentry_dsn", "https://" + hex(32) + "@o0.ingest.sentry.io/12345"],
    ["groq_api_key", "gsk_" + b62(52)],
    ["perplexity_api_key", "pplx-" + b62(40)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss variants of the new AI/SaaS credential formats", () => {
  // One char short of the fixed/minimum length must produce no finding.
  const nearMisses = [
    "AKCp8" + b62(68),
    "duffel_test_" + b62(42),
    "EZAK" + b62(53),
    "CFPAT-" + b62(42),
    "pul-" + hex(39),
    "aio_" + b62(27),
    "gsk_" + b62(51),
    "sqp_" + hex(39),
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});

test("scanPatch flags webhook-URL, CI/CD, and payment/SaaS credential formats", () => {
  // base64url-body formats deliberately END IN `-` to prove the rule terminates on a negative-lookahead, not `\b`.
  const cases = [
    ["discord_webhook_url", "https://discord.com/api/webhooks/123456789012345678/" + b62(69) + "-"],
    ["teams_webhook_url", "https://acme.webhook.office.com/webhookb2/" + b62(20) + "@" + b62(20) + "/IncomingWebhook/" + b62(32) + "/" + b62(20)],
    ["figma_pat", "figd_" + b62(42) + "-"],
    ["dockerhub_pat", "dckr_pat_" + b62(26) + "-"],
    ["gitlab_feed_token", "glft-" + hex(20)],
    ["gitlab_deploy_token", "gldt-" + b62(19) + "-"],
    ["razorpay_key", "rzp_test_" + b62(14)],
    ["supabase_token", "sbp_" + hex(40)],
    ["cloudinary_url", "cloudinary://123456789012345:" + b62(25) + "@mycloud"],
    ["brevo_api_key", "xkeysib-" + hex(64) + "-" + b62(16)],
    ["buildkite_token", "bkua_" + hex(40)],
    ["nuget_api_key", "oy2" + hex(43)],
    ["hubspot_pat", "pat-na1-" + hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss variants of the webhook/CI/SaaS formats", () => {
  const nearMisses = [
    "figd_" + b62(39),
    "dckr_pat_" + b62(26),
    "gldt-" + b62(19),
    "glft-" + hex(19),
    "sbp_" + hex(39),
    "bkua_" + hex(39),
    "oy2" + hex(42),
    "rzp_test_" + b62(13),
    "xkeysib-" + hex(63) + "-" + b62(16),
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});

test("scanPatch flags more SaaS/cloud/AI-provider credential formats", () => {
  const cases = [
    ["atlassian_api_token", "ATATT3xFfGF0" + b62(60)],
    ["alibaba_access_key", "LTAI" + b62(20)],
    ["langsmith_api_key", "lsv2_pt_" + hex(32) + "_" + hex(10)],
    ["plaid_access_token", "access-sandbox-" + hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12)],
    ["launchdarkly_key", "sdk-" + hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12)],
    ["grafana_cloud_token", "glc_" + b62(32)],
    ["dbt_cloud_token", "dbtc_" + b62(29) + "-"], // ends in `-` to guard the lookahead terminator
    ["posthog_personal_key", "phx_" + b62(32)],
    ["render_api_key", "rnd_" + b62(24)],
    ["jina_api_key", "jina_" + b62(28)],
    ["sentry_user_token", "sntryu_" + hex(64)],
    ["replicate_token", "r8_" + b62(37)],
    ["openrouter_key", "sk-or-v1-" + hex(64)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss variants of the new SaaS/AI formats", () => {
  const nearMisses = [
    "LTAI" + b62(19),
    "glc_" + b62(31),
    "phx_" + b62(31),
    "rnd_" + b62(23),
    "jina_" + b62(27),
    "sntryu_" + hex(63),
    "r8_" + b62(36),
    "sk-or-v1-" + hex(63),
    "dbtc_" + b62(29),
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});

test("scanPatch flags additional infrastructure/AI-provider credential formats", () => {
  const cases = [
    ["amazon_mws_token", "amzn.mws." + hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12)],
    ["tencent_secret_id", "AKID" + b62(32)],
    ["ory_pat", "ory_pat_" + b62(32)],
    ["braintree_token", "access_token$production$" + hex(16) + "$" + hex(32)],
    ["mailersend_token", "mlsn." + hex(64)],
    ["ghost_admin_key", hex(24) + ":" + hex(64)],
    ["xata_api_key", "xau_" + b62(40)],
    ["deno_deploy_token", "ddp_" + b62(40)],
    ["onepassword_service_token", "ops_eyJ" + b62(40)],
    ["runpod_api_key", "rpa_" + b62(32)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss variants of the infra/AI credential formats", () => {
  const nearMisses = [
    "AKID" + b62(31),
    "ory_pat_" + b62(31),
    "mlsn." + hex(63),
    hex(24) + ":" + hex(63),
    "xau_" + b62(39),
    "ddp_" + b62(39),
    "ops_eyJ" + b62(39),
    "rpa_" + b62(31),
    "amzn.mws." + hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(11),
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});

test("scanPatch flags observability and CI/identity credential formats", () => {
  const cases = [
    ["newrelic_insights_key", "NRII-" + b62(32)],
    ["newrelic_rest_key", "NRRA-" + hex(42)],
    ["sentry_org_token", "sntrys_" + b62(40)],
    ["openai_service_account_key", "sk-svcacct-" + b62(40)],
    ["google_oauth_access_token", "ya29." + b62(40)],
    ["persona_api_key", "persona_sandbox_" + b62(24)],
    ["depot_token", "depot_project_" + b62(20)],
    ["octopus_deploy_key", "API-" + b62(26)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss variants of the observability/CI formats", () => {
  const nearMisses = [
    "NRII-" + b62(31),
    "NRRA-" + hex(41),
    "sntrys_" + b62(39),
    "sk-svcacct-" + b62(19),
    "ya29." + b62(19),
    "persona_sandbox_" + b62(23),
    "depot_project_" + b62(19),
    "API-" + b62(25),
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});

test("scanPatch flags developer-platform (CI/AI/DB) credential formats", () => {
  const cases = [
    ["inngest_signing_key", "signkey-prod-" + hex(64)],
    ["trigger_dev_key", "tr_prod_" + b62(20)],
    ["cal_com_api_key", "cal_live_" + hex(20)],
    ["cerebras_api_key", "csk-" + b62(40)],
    ["helicone_api_key", "sk-helicone-" + b62(20)],
    ["langfuse_secret_key", "sk-lf-" + b62(20)],
    ["neon_api_key", "napi_" + b62(40)],
  ];
  for (const [kind, secret] of cases) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${secret}";`]));
    assert.equal(findings.length, 1, `${kind}: expected exactly one finding, got ${JSON.stringify(findings)}`);
    assert.equal(findings[0].kind, kind, `${kind}: wrong kind`);
    assert.equal(findings[0].confidence, "high", `${kind}: wrong confidence`);
  }
});

test("scanPatch does not flag near-miss variants of the developer-platform formats", () => {
  const nearMisses = [
    "signkey-prod-" + hex(63),
    "tr_prod_" + b62(19),
    "cal_live_" + hex(19),
    "csk-" + b62(39),
    "sk-helicone-" + b62(19),
    "sk-lf-" + b62(19),
    "napi_" + b62(39),
    // A hex/base62 run that continues into a non-hex word char is NOT a completed token: the `\b` terminator
    // must reject the embedded prefix (a `(?![a-f0-9])`-style lookahead would wrongly flag it).
    "cal_live_" + hex(20) + "g",
    "napi_" + b62(40) + "_extra",
  ];
  for (const nm of nearMisses) {
    const findings = scanPatch("src/config.ts", hunk([`const c = "${nm}";`]));
    assert.equal(findings.length, 0, `near-miss should not match: ${nm}`);
  }
});
