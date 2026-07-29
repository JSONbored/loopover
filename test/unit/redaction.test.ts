import { describe, expect, it } from "vitest";
import {
  isPublicSafeText,
  PUBLIC_LOCAL_PATH_INLINE,
  PUBLIC_LOCAL_PATH_PREFIX_PATTERN,
  PUBLIC_LOCAL_PATH_SCRUB_PATTERN,
  PUBLIC_TOKEN_INLINE,
  PUBLIC_UNSAFE_PATTERN,
  publicTokenPattern,
} from "../../src/signals/redaction";

// Every prefix in PUBLIC_TOKEN_INLINE, as a concrete leaked-token sample (body is pure alphanumerics so it is
// fully consumed by both the `[A-Za-z0-9_=-]{8,}` and `[A-Za-z0-9_]+` body classes the call sites use).
const PUBLIC_TOKEN_SAMPLES: [string, string][] = [
  ["ghp_", `ghp_${"A".repeat(24)}`],
  ["gho_", `gho_${"A".repeat(24)}`],
  ["ghu_", `ghu_${"A".repeat(24)}`],
  ["ghs_", `ghs_${"A".repeat(24)}`],
  ["ghr_", `ghr_${"A".repeat(24)}`],
  ["github_pat_", `github_pat_${"A".repeat(24)}`],
  ["gts_", `gts_${"A".repeat(24)}`],
  ["orbenr_", `orbenr_${"A".repeat(24)}`],
  ["orbsec_", `orbsec_${"A".repeat(24)}`],
  ["glpat-", `glpat-${"A".repeat(24)}`],
  ["sk-", `sk-${"A".repeat(24)}`],
  ["xoxb-", `xoxb-${"A".repeat(24)}`],
];

describe("publicTokenPattern / PUBLIC_TOKEN_INLINE (#9697)", () => {
  it("returns a FRESH /g RegExp on each call, never a shared stateful object", () => {
    const a = publicTokenPattern();
    const b = publicTokenPattern();
    expect(a).not.toBe(b);
    expect(a.global).toBe(true);
  });

  it("stays idempotent across repeated .replace() on the same input (no shared lastIndex carry-over)", () => {
    const input = `leak ghs_${"A".repeat(24)} and gho_${"B".repeat(24)} here`;
    const first = input.replace(publicTokenPattern(), "<redacted-token>");
    const second = input.replace(publicTokenPattern(), "<redacted-token>");
    expect(first).toBe(second);
    expect(first).toContain("<redacted-token>");
    expect(first).not.toMatch(/gh[so]_/);
  });

  it.each(PUBLIC_TOKEN_SAMPLES)("redacts a %s token via publicTokenPattern()", (_prefix, token) => {
    const out = `x ${token} y`.replace(publicTokenPattern(), "<redacted-token>");
    expect(out).toBe("x <redacted-token> y");
    expect(out).not.toContain(token);
  });

  it("leaves a non-token string untouched", () => {
    expect("plain reviewable summary text".replace(publicTokenPattern(), "<redacted-token>")).toBe("plain reviewable summary text");
    expect(PUBLIC_TOKEN_INLINE).toContain("gh[pousr]_"); // ghs_/gho_/ghu_/ghr_ covered by the GitHub class
  });
});

describe("isPublicSafeText (#542 shared public/private boundary)", () => {
  it("accepts text with no private signals", () => {
    expect(isPublicSafeText("Add a retry to the cache reconnect path.")).toBe(true);
    expect(isPublicSafeText("- PR #12: changes requested.")).toBe(true);
    expect(isPublicSafeText("")).toBe(true);
  });

  it("rejects gittensor economic / identity signals", () => {
    for (const text of [
      "estimated reward is high",
      "your score will rise",
      "wallet 5F...",
      "hotkey leaked",
      "coldkey backup",
      "mnemonic phrase",
      "this looks like farming",
      "payout pending",
      "ranking change",
      "raw trust value",
      "raw-trust score",
      "trust_score 0.8",
      "private reviewability internals",
      "reviewability breakdown",
    ]) {
      expect(isPublicSafeText(text)).toBe(false);
    }
  });

  it("rejects plural signal nouns (the closing \\b must not slip the trailing 's' past a bare term)", () => {
    for (const text of ["your wallets here", "hotkeys", "coldkeys", "mnemonics", "payouts", "rankings", "rewards", "scores"]) {
      expect(isPublicSafeText(text)).toBe(false);
    }
  });

  it("rejects local filesystem paths (posix and Windows)", () => {
    expect(isPublicSafeText("/Users/alice/project")).toBe(false);
    expect(isPublicSafeText("/home/bob/repo")).toBe(false);
    expect(isPublicSafeText("/root/project/src")).toBe(false);
    expect(isPublicSafeText("clone failed at /root/work/repo")).toBe(false);
    expect(isPublicSafeText("/var/log/app.log")).toBe(false);
    expect(isPublicSafeText("/var/folders/alice/work/private-repo/cache.ts")).toBe(false);
    expect(isPublicSafeText("/tmp/scratch")).toBe(false);
    expect(isPublicSafeText("/private/tmp/loopover/cache")).toBe(false);
    expect(isPublicSafeText("C:\\Users\\carol\\repo")).toBe(false);
    expect(isPublicSafeText("C:/Users/carol/repo")).toBe(false);
    expect(isPublicSafeText("/opt/homebrew/var/log")).toBe(false);
    expect(isPublicSafeText("C:\\Program Files\\App\\config.json")).toBe(false);
    expect(isPublicSafeText("C:/Program Files/App/config.json")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPublicSafeText("WALLET")).toBe(false);
    expect(isPublicSafeText("Payout")).toBe(false);
  });

  it("uses a NON-global pattern so .test() is stateless (no lastIndex carry-over)", () => {
    expect(PUBLIC_UNSAFE_PATTERN.global).toBe(false);
    // A global regex would alternate true/false across repeated .test() calls on the same input.
    expect(PUBLIC_UNSAFE_PATTERN.test("wallet")).toBe(true);
    expect(PUBLIC_UNSAFE_PATTERN.test("wallet")).toBe(true);
    expect(isPublicSafeText("clean line")).toBe(true);
    expect(isPublicSafeText("clean line")).toBe(true);
  });
});

describe("shared local-path constants (#1418 drift fix)", () => {
  it("scrubs every local root, including /root/ and /var/, plus both Windows forms", () => {
    expect("clone at /Users/me/repo/src done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("clone at <p> done");
    expect("clone at /home/me/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("clone at <p> done");
    expect("clone at /root/work/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("clone at <p> done");
    expect("log at /var/log/app.log done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("log at <p> done");
    expect("brew at /opt/homebrew/var/log done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("brew at <p> done");
    expect("tmp at /tmp/build done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("tmp at <p> done");
    expect("mac at /private/tmp/build done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("mac at <p> done");
    expect("win at C:\\Users\\me\\repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    expect("win at C:/Users/me/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    // Lower-case drive letter: the source matches it case-insensitively, so a consumer that omits the `i`
    // flag (the `/g`-only scrubber in miner-dashboard-recommendations.ts) still redacts it (#1418 regression).
    expect("win at c:\\Users\\bob\\repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    expect("win at c:/Users/bob/repo done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
    expect("win at C:/Program Files/App/x done".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>")).toBe("win at <p> done");
  });

  it("the lower-case Windows drive is matched by the raw source even without the `i` flag", () => {
    // miner-dashboard-recommendations.ts composes a `/g`-only (no `i`) scrubber from PUBLIC_LOCAL_PATH_INLINE,
    // so the drive-letter class in the source must itself be case-insensitive ([A-Za-z], not [A-Z]).
    const gOnly = new RegExp(`(?:${PUBLIC_LOCAL_PATH_INLINE})[^\\s]*`, "g");
    expect("at c:\\Users\\bob\\x".replace(gOnly, "<p>")).toBe("at <p>");
    expect("at C:\\Users\\bob\\x".replace(gOnly, "<p>")).toBe("at <p>");
  });

  it("the shared `/g` scrubber resets lastIndex between .replace() calls (safe to share across modules)", () => {
    const first = "a /tmp/one b".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>");
    const second = "a /tmp/one b".replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<p>");
    expect(first).toBe("a <p> b");
    expect(second).toBe(first);
  });

  it("scrub pattern is global (safe for .replace across modules) and prefix pattern is anchored + non-global", () => {
    expect(PUBLIC_LOCAL_PATH_SCRUB_PATTERN.global).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.global).toBe(false);
  });

  it("prefix pattern matches a path that STARTS at a local root, not one merely containing it", () => {
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/root/work/repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/var/folders/me/repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("C:/Users/me/repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("C:\\Users\\me\\repo")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("src/signals/redaction.ts")).toBe(false);
    // Non-global so .test() stays stateless across repeated calls on the same input.
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/root/x")).toBe(true);
    expect(PUBLIC_LOCAL_PATH_PREFIX_PATTERN.test("/root/x")).toBe(true);
  });
});
