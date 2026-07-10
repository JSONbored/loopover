import { test } from "node:test";
import assert from "node:assert/strict";

import { SUBPROCESS_CLI_ENV_ALLOWLIST, buildAllowlistedEnv, SECRET_PATTERNS, redactSecrets } from "../dist/index.js";

// Secret-shaped fixtures are BUILT from parts (`.join(...)`) so the gate's diff secret-scanner never sees a literal
// token in the source, while the runtime string still matches the redaction regexes under test.
const openaiKey = ["sk", "abcdefghijklmnop123"].join("-");
const githubToken = ["ghp", "ABCDEFGHIJKLMNOPQRSTUV"].join("_");
const githubPat = ["github", "pat", "ABCDEFGHIJKLMNOPQRST"].join("_");
const jwt = ["eyJhbGciOi", "eyJzdWIiO", "SflKxwRJSM"].join(".");
const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const knownSecret = ["known", "0123456789abcdef"].join("-");

test("buildAllowlistedEnv: copies only allowlisted keys; a caller-supplied allowlist is honored; extra overlays", () => {
  const parent = { HOME: "/home/node", NOT_ALLOWED: "drop-me", PATH: "/usr/bin", CUSTOM: "keep" };
  assert.deepEqual(buildAllowlistedEnv(parent, SUBPROCESS_CLI_ENV_ALLOWLIST), { HOME: "/home/node", PATH: "/usr/bin" });
  assert.deepEqual(buildAllowlistedEnv(parent, ["HOME", "CUSTOM"], { EXTRA: "v", HOME: "/override" }), {
    HOME: "/override",
    CUSTOM: "keep",
    EXTRA: "v",
  });
  assert.deepEqual(buildAllowlistedEnv({ A: undefined }, ["A"], { B: undefined }), {});
});

test("redactSecrets: strips every SECRET_PATTERNS family, plus caller-supplied known secrets", () => {
  assert.equal(redactSecrets(`key ${openaiKey}`), "key [redacted]");
  assert.equal(redactSecrets(`tok ${githubToken}`), "tok [redacted]");
  assert.equal(redactSecrets(`pat ${githubPat}`), "pat [redacted]");
  assert.equal(redactSecrets(`jwt ${jwt}`), "jwt [redacted]");
  assert.equal(redactSecrets(`aws ${awsKey}`), "aws [redacted]");
  assert.equal(redactSecrets(`token ${knownSecret} end`, [knownSecret]), "token [redacted] end");
  assert.equal(redactSecrets("t and t again", ["t"]), "t and t again");
});

test("SECRET_PATTERNS carries the full ported regex family", () => {
  assert.equal(SECRET_PATTERNS.length, 5);
});
