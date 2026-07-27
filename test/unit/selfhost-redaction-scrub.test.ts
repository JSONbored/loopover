import { describe, expect, it } from "vitest";
import {
  OPERATIONAL_TAG_KEYS,
  REDACTED,
  scrubRecord,
  scrubString,
  scrubStringField,
} from "../../src/selfhost/redaction-scrub";

const fakeClassicAccessToken = (): string => `${"github" + "_pat_"}${"a".repeat(24)}`;

describe("scrubStringField — structured identifiers skip vocabulary scrubbing (#9142)", () => {
  // The sharpest, easiest-to-verify regression in the fix: PUBLIC_UNSAFE_SCRUB's bare `\b(reward|score|
  // wallet|hotkey|...)\w*\b` match used to fire on the "score" segment inside "ossf/scorecard" (a repo full
  // name, reached via scrubStringField's dispatch) and corrupt it into "ossf/private context" -- a real repo,
  // reviewed on GitHub, whose label would silently corrupt on every single captured event.
  it("REGRESSION (#9142): 'ossf/scorecard' survives scrubbing intact under the `repo` key", () => {
    expect(scrubStringField("repo", "ossf/scorecard")).toBe("ossf/scorecard");
  });

  it("still corrupts the SAME string under a non-identifier (free-text) key -- proves the bypass is key-scoped, not global", () => {
    expect(scrubStringField("detail", "ossf/scorecard")).toBe("ossf/private context");
    expect(scrubString("ossf/scorecard")).toBe("ossf/private context");
  });

  it.each(["reward", "wallet", "hotkey", "coldkey", "mnemonic", "payout", "ranking", "cohort"])(
    "does not corrupt a repo name whose segment starts with the vocabulary word '%s'",
    (word) => {
      const repo = `some-org/${word}-analytics`;
      expect(scrubStringField("repo", repo)).toBe(repo);
    },
  );

  it("two differently-named repos that both start with a vocabulary word no longer collapse to the same corrupted label", () => {
    const a = scrubStringField("repo", "org-a/scorecard-tools");
    const b = scrubStringField("repo", "org-b/score-keeper");
    expect(a).not.toBe(b);
    expect(a).toBe("org-a/scorecard-tools");
    expect(b).toBe("org-b/score-keeper");
  });

  it("applies to every OPERATIONAL_TAG_KEYS entry, not just repo", () => {
    for (const key of OPERATIONAL_TAG_KEYS) {
      expect(scrubStringField(key, "cohort-alpha")).toBe("cohort-alpha");
    }
  });

  it("still redacts a credential-shaped value even under a structured-identifier key (credential scrubbing stays unconditional)", () => {
    const token = fakeClassicAccessToken();
    expect(scrubStringField("repo", `owner/${token}`)).toBe(`owner/${REDACTED}`);
  });

  it("still redacts a JWT-shaped value under a structured-identifier key", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYb0nSYw";
    expect(scrubStringField("head_sha", jwt)).toBe(REDACTED);
  });

  it("still redacts a query-string secret parameter under a structured-identifier key", () => {
    expect(scrubStringField("repo", "owner/repo?token=shhhhh")).toBe(`owner/repo?token=${REDACTED}`);
  });

  it("a key not in OPERATIONAL_TAG_KEYS still gets full vocabulary scrubbing (baseline, unaffected by this change)", () => {
    expect(scrubStringField("message", "reward estimate leaked")).toContain("private context");
  });

  it("still routes a URL-shaped key through scrubUrl (unaffected by the identifier bypass ordering)", () => {
    const result = scrubStringField("targetUrl", "https://example.com/x?token=shh");
    expect(result).not.toContain("shh");
    expect(result).toContain("https://example.com/x?token=");
  });

  it("still routes a query-shaped key through scrubQueryString (unaffected by the identifier bypass ordering)", () => {
    // URLSearchParams re-serialization percent-encodes REDACTED's brackets ("[" / "]") -- pre-existing
    // scrubQueryString behavior, unrelated to and unaffected by this change; just confirming routing.
    const result = scrubStringField("query", "token=shh&other=value");
    expect(result).not.toContain("shh");
    expect(result).toContain("other=value");
  });
});

describe("scrubRecord — end-to-end via the structured-identifier keys (#9142)", () => {
  it("leaves a repo full name intact when scrubbing a whole properties bag", () => {
    const properties: Record<string, unknown> = { repo: "ossf/scorecard", pull: 7, detail: "reward estimate leaked" };
    scrubRecord(properties, 0);
    expect(properties.repo).toBe("ossf/scorecard");
    expect(properties.pull).toBe(7);
    expect(properties.detail).toContain("private context");
  });
});
