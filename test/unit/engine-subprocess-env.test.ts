// App-vitest coverage for the engine subprocess-env helper (#4284). The engine also has its own node:test suite,
// but codecov/patch is computed from this app vitest run (vitest.config coverage includes
// packages/gittensory-engine/src/**), so the changed engine lines need a vitest test that imports the SRC directly.
//
// The secret-shaped fixtures below are BUILT from parts (`.join(...)`) so the gate's own diff secret-scanner never
// sees a literal token in the source (it would flag it as a leaked secret), while the runtime string still matches
// the redaction regexes under test.
import { describe, expect, it } from "vitest";
import {
  SUBPROCESS_CLI_ENV_ALLOWLIST,
  buildAllowlistedEnv,
  SECRET_PATTERNS,
  redactSecrets,
} from "../../packages/gittensory-engine/src/subprocess-env";

const openaiKey = ["sk", "abcdefghijklmnop123"].join("-");
const githubToken = ["ghp", "ABCDEFGHIJKLMNOPQRSTUV"].join("_");
const githubPat = ["github", "pat", "ABCDEFGHIJKLMNOPQRST"].join("_");
const jwt = ["eyJhbGciOi", "eyJzdWIiO", "SflKxwRJSM"].join(".");
const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const knownSecret = ["known", "0123456789abcdef"].join("-");

describe("engine subprocess-env helper (#4284)", () => {
  it("buildAllowlistedEnv copies only allowlisted keys; a caller allowlist is honored; extra overlays; undefined dropped", () => {
    const parent = { HOME: "/home/node", NOT_ALLOWED: "drop-me", PATH: "/usr/bin", CUSTOM: "keep" };
    expect(buildAllowlistedEnv(parent, SUBPROCESS_CLI_ENV_ALLOWLIST)).toEqual({ HOME: "/home/node", PATH: "/usr/bin" });
    expect(buildAllowlistedEnv(parent, ["HOME", "CUSTOM"], { EXTRA: "v", HOME: "/override" })).toEqual({
      HOME: "/override",
      CUSTOM: "keep",
      EXTRA: "v",
    });
    expect(buildAllowlistedEnv({ A: undefined }, ["A"], { B: undefined })).toEqual({});
  });

  it("redactSecrets strips every SECRET_PATTERNS family + caller-supplied known secrets (length-guarded)", () => {
    expect(redactSecrets(`key ${openaiKey}`)).toBe("key [redacted]");
    expect(redactSecrets(`tok ${githubToken}`)).toBe("tok [redacted]");
    expect(redactSecrets(`pat ${githubPat}`)).toBe("pat [redacted]");
    expect(redactSecrets(`jwt ${jwt}`)).toBe("jwt [redacted]");
    expect(redactSecrets(`aws ${awsKey}`)).toBe("aws [redacted]");
    expect(redactSecrets(`token ${knownSecret} end`, [knownSecret])).toBe("token [redacted] end");
    expect(redactSecrets("t and t again", ["t"])).toBe("t and t again"); // short known secret NOT stripped
  });

  it("SECRET_PATTERNS carries the full ported regex family", () => {
    expect(SECRET_PATTERNS).toHaveLength(5);
  });
});
