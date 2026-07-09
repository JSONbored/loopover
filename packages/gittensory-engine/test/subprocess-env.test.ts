import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAllowlistedEnv,
  redactSubprocessSecrets,
  SUBPROCESS_SECRET_PATTERNS,
  SUBSCRIPTION_CLI_ENV_ALLOWLIST,
} from "../dist/index.js";

test("buildAllowlistedEnv honors a CALLER-SUPPLIED allowlist, not just the hardcoded default", () => {
  const parent = { FOO: "1", BAR: "2", SECRET_TOKEN: "keep-out", PATH: "/bin" };
  const child = buildAllowlistedEnv(parent, ["FOO", "BAR"]);
  assert.deepEqual(child, { FOO: "1", BAR: "2" });
  // A key outside the caller's allowlist is dropped even though it exists in parent.
  assert.equal("SECRET_TOKEN" in child, false);
  assert.equal("PATH" in child, false);
});

test("buildAllowlistedEnv layers `extra` over the allowlisted copy", () => {
  const child = buildAllowlistedEnv({ HOME: "/home/x" }, ["HOME"], { EXTRA: "e", HOME: "/override" });
  assert.deepEqual(child, { HOME: "/override", EXTRA: "e" });
});

test("buildAllowlistedEnv omits undefined values from both parent and extra", () => {
  const child = buildAllowlistedEnv(
    { HOME: "/home/x", LANG: undefined },
    ["HOME", "LANG", "MISSING"],
    { E1: "v", E2: undefined },
  );
  assert.deepEqual(child, { HOME: "/home/x", E1: "v" });
  assert.equal("LANG" in child, false); // present-but-undefined in parent
  assert.equal("MISSING" in child, false); // absent in parent
  assert.equal("E2" in child, false); // undefined in extra
});

test("SUBSCRIPTION_CLI_ENV_ALLOWLIST default carries the ai.ts key set (PATH/HOME/proxy/cert/XDG)", () => {
  for (const key of ["HOME", "PATH", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "XDG_CONFIG_HOME", "no_proxy"]) {
    assert.ok(SUBSCRIPTION_CLI_ENV_ALLOWLIST.includes(key), `allowlist missing ${key}`);
  }
  const child = buildAllowlistedEnv({ HOME: "/h", PATH: "/bin", UNLISTED: "x" }, SUBSCRIPTION_CLI_ENV_ALLOWLIST);
  assert.deepEqual(child, { HOME: "/h", PATH: "/bin" });
});

test("redactSubprocessSecrets strips every carried-over token shape (ported, not weakened)", () => {
  const cases = [
    "sk-abcdefghijklmnop1234", // OpenAI / Anthropic
    "ghp_ABCDEFGHIJKLMNOPQRST12", // GitHub token
    "github_pat_ABCDEFGHIJKLMNOPQRST1234", // GitHub fine-grained PAT
    "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM", // JWT
    "AKIA1234567890ABCDEF", // AWS access key id
  ];
  for (const secret of cases) {
    const out = redactSubprocessSecrets(`error: leaked ${secret} here`);
    assert.equal(out.includes(secret), false, `did not redact ${secret}`);
    assert.match(out, /\[redacted\]/);
  }
});

test("redactSubprocessSecrets strips known secret VALUES that are long enough, but guards short ones", () => {
  const long = redactSubprocessSecrets("token=mysupersecretvalue done", ["mysupersecretvalue"]);
  assert.equal(long.includes("mysupersecretvalue"), false);
  assert.match(long, /token=\[redacted\] done/);

  // A <8-char "secret" must NOT blank unrelated diagnostic text.
  const short = redactSubprocessSecrets("the cat sat", ["cat"]);
  assert.equal(short, "the cat sat");
});

test("redactSubprocessSecrets leaves clean text untouched, and the pattern family is exported", () => {
  assert.equal(redactSubprocessSecrets("nothing to see here"), "nothing to see here");
  assert.equal(SUBPROCESS_SECRET_PATTERNS.length, 5);
});
