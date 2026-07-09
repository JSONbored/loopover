import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAllowlistedEnv,
  redactSubprocessSecrets,
  DEFAULT_SUBPROCESS_ENV_ALLOWLIST,
} from "../dist/index.js";

// Structurally-valid but obviously-fake placeholder tokens (the same low-entropy / EXAMPLE convention the
// repo's own secrets-scan tests use) — no real credential is present in this file.
const FAKE = {
  openai: "sk-ABCDEFGHIJKLMNOP0123",
  github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  githubPat: "github_pat_ABCDEFGHIJKLMNOPQRSTUV",
  jwt: "eyJhbGciOi.eyJzdWIiOi.SIGNATUREXX",
  aws: "AKIAIOSFODNN7EXAMPLE",
};

test("buildAllowlistedEnv keeps only allowlisted keys from the parent (default allowlist)", () => {
  const child = buildAllowlistedEnv({
    HOME: "/home/node",
    PATH: "/usr/bin",
    OPENAI_API_KEY: "should-not-pass", // not on the allowlist
    ANTHROPIC_API_KEY: "should-not-pass",
  });
  assert.deepEqual(child, { HOME: "/home/node", PATH: "/usr/bin" }); // secrets excluded
});

test("buildAllowlistedEnv honors a caller-supplied allowlist, not just the default", () => {
  const child = buildAllowlistedEnv(
    { FOO: "1", BAR: "2", HOME: "/home/node" },
    { allowlist: ["FOO", "BAR"] },
  );
  assert.deepEqual(child, { FOO: "1", BAR: "2" }); // HOME on the default list but not this caller's list, so excluded
});

test("buildAllowlistedEnv skips allowlisted keys absent from the parent", () => {
  const child = buildAllowlistedEnv({ HOME: "/home/node" }); // PATH etc. absent
  assert.deepEqual(child, { HOME: "/home/node" });
});

test("buildAllowlistedEnv overlays extra (defined wins, undefined is skipped)", () => {
  const child = buildAllowlistedEnv(
    { HOME: "/home/node", PATH: "/usr/bin" },
    { extra: { PATH: "/opt/bin", CLAUDE_MODEL: "claude-sonnet-5", EMPTY: undefined } },
  );
  assert.equal(child.PATH, "/opt/bin"); // extra overrides the allowlisted value
  assert.equal(child.CLAUDE_MODEL, "claude-sonnet-5"); // extra can add a non-allowlisted key
  assert.equal("EMPTY" in child, false); // undefined extra is skipped
  assert.equal(child.HOME, "/home/node");
});

test("DEFAULT_SUBPROCESS_ENV_ALLOWLIST includes the core CLI-auth/proxy/cert keys", () => {
  for (const key of ["HOME", "PATH", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY"]) {
    assert.ok(DEFAULT_SUBPROCESS_ENV_ALLOWLIST.includes(key), `missing ${key}`);
  }
});

test("redactSubprocessSecrets redacts every well-known token shape", () => {
  for (const [kind, tok] of Object.entries(FAKE)) {
    const out = redactSubprocessSecrets(`stderr: leaked ${tok} here`);
    assert.equal(out.includes(tok), false, `${kind} not redacted`);
    assert.match(out, /\[redacted\]/);
  }
});

test("redactSubprocessSecrets strips a caller-supplied known secret exactly (length-guarded ≥ 8)", () => {
  const secret = "supersecrettokenvalue";
  assert.match(redactSubprocessSecrets(`used ${secret}`, [secret]), /used \[redacted\]/);
});

test("redactSubprocessSecrets does NOT blank a short (<8) known secret, to protect unrelated text", () => {
  const out = redactSubprocessSecrets("the value t appears in tent and butter", ["t"]);
  assert.equal(out, "the value t appears in tent and butter"); // unchanged
});

test("redactSubprocessSecrets leaves ordinary text untouched", () => {
  const clean = "run finished: 3 files changed, 0 errors";
  assert.equal(redactSubprocessSecrets(clean), clean);
});
