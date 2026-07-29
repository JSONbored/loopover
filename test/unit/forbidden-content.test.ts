import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content";
import { ADVISORY_ONLY_SECRET_KINDS, HARD_SECRET_KINDS, SECRET_PATTERNS } from "../../src/review/secret-patterns";

// forbidden-content.ts calls itself the single source of truth for the packaged secret-shape detector, but
// nothing enforced it: check-mcp-package.ts re-declared the regex as its own local constant and the two could
// drift apart unnoticed (#6290). These assertions pin both halves of the claim -- the structural one (each
// checker imports the constant rather than owning a copy) and the behavioral one (each checker actually rejects
// what the shared detector matches).
const PACKAGE_CHECKERS = ["scripts/check-miner-package.ts", "scripts/check-mcp-package.ts"];

// A minimal file list that passes each checker's path/allowlist/required-file guards, so the run reaches the
// shared secret-content read. Mirrors the file lists each checker's own "rejects secret-like content" test uses.
// LICENSE is in both lists because both checkers now REQUIRE it (#9787): a published package that declares
// a license in package.json but ships no LICENSE file is the drift that change exists to catch. Without it
// the MCP checker exits on "Missing required file" before it ever reads content, and this file's clean-content
// case would be asserting the required-file guard rather than the shared detector.
const REACHABLE_FILES: Record<string, string[]> = {
  "scripts/check-miner-package.ts": ["package.json", "LICENSE", "dist/bin/loopover-miner.js", "dist/lib/cli.js"],
  "scripts/check-mcp-package.ts": ["package.json", "LICENSE", "dist/bin/loopover-mcp.js"],
};

// Assembled from fragments so this file never itself contains a credential-shaped literal -- the same
// convention check-mcp-package.test.ts and check-miner-package.test.ts already use for their probes.
const SECRET_SHAPED_PROBE = ["PROBE", "_", "SECRET", "=", "value"].join("");

// Run a checker as a subprocess (never import it): both scripts run `npm pack` at import time, and neither has a
// .d.mts, so importing them from TS would also break the typecheck gate. Their env seams let a single file drive
// the whole file list + content. Run via tsx, not plain node: both scripts import forbidden-content.ts (and
// check-mcp-package.ts also imports mcp-package-allowlist.ts) directly, so plain node can't resolve those
// local .ts imports.
const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

function runChecker(
  checker: string,
  files: string[],
  content: string,
): { status: number; out: string } {
  const isMiner = checker.includes("miner");
  const env = {
    ...process.env,
    [isMiner ? "CHECK_MINER_PACK_TEST_FILES" : "CHECK_MCP_PACK_TEST_FILES"]: JSON.stringify(files),
    [isMiner ? "CHECK_MINER_PACK_TEST_CONTENT" : "CHECK_MCP_PACK_TEST_CONTENT"]: content,
  };
  try {
    return { status: 0, out: execFileSync(TSX_BIN, [checker], { encoding: "utf8", env }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("FORBIDDEN_CONTENT is the single source of truth (#6290)", () => {
  it.each(PACKAGE_CHECKERS)("%s imports the shared constant instead of re-declaring it", (checker) => {
    const source = readFileSync(checker, "utf8");
    expect(source).toContain('import { FORBIDDEN_CONTENT } from "./forbidden-content";');
    expect(source).toContain("FORBIDDEN_CONTENT.test(");
    // The drift this guards against: a checker owning its own copy of the detector.
    expect(source).not.toMatch(/const\s+FORBIDDEN_CONTENT\s*=/);
  });

  it.each(PACKAGE_CHECKERS)("%s rejects content the shared detector matches", (checker) => {
    // Sanity-check the probe really is what the shared detector flags, then that the checker enforces it.
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
    const result = runChecker(checker, REACHABLE_FILES[checker]!, SECRET_SHAPED_PROBE);
    expect(result.status).toBe(1);
    expect(result.out).toContain("Secret-like content found in");
  });

  // Scoped to the MCP checker: the miner one layers required-file / lib-artifact / docs guards on top of a
  // minimal file list, so a clean-content pass there would be asserting its allowlist rather than the shared
  // detector. The reject case above already proves the miner checker runs content through the shared constant.
  it("scripts/check-mcp-package.ts accepts content the shared detector leaves alone", () => {
    const result = runChecker(
      "scripts/check-mcp-package.ts",
      REACHABLE_FILES["scripts/check-mcp-package.ts"]!,
      "export const answer = 42;",
    );
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/MCP package dry-run ok:/);
  });

  it("is a stateless matcher, so the shared instance is safe across checkers", () => {
    // A global/sticky regex would carry lastIndex between .test() calls and make shared use order-dependent.
    expect(FORBIDDEN_CONTENT.global).toBe(false);
    expect(FORBIDDEN_CONTENT.sticky).toBe(false);
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
  });
});

describe("FORBIDDEN_CONTENT covers the concrete provider-key formats (#7433)", () => {
  // One representative fixture per newly-added HARD_SECRET_KINDS format, each assembled from fragments so this
  // file never contains a contiguous credential-shaped literal (same convention as secret-patterns.test.ts).
  const A = (n: number) => "A".repeat(n);
  const a = (n: number) => "a".repeat(n);
  const NEW_FORMAT_PROBES: Array<[string, string]> = [
    ["aws_access_key", "AKIA" + "IOSFODNN7EXAMPLE"],
    ["slack_token", "xox" + "b-" + a(12)],
    ["google_api_key", "AIza" + a(35)],
    ["gitlab_token", "glpat-" + a(20)],
    ["npm_token", "npm_" + a(36)],
    ["stripe_secret_key", "sk" + "_live_" + a(24)],
    ["sendgrid_key", "SG." + a(22) + "." + a(43)],
    ["huggingface_token", "hf_" + a(34)],
    ["voyage_api_key", "pa" + "-" + a(20)],
    ["firecrawl_api_key", "fc" + "-" + a(16)],
    ["openai_api_key", "sk-" + a(20) + "T3Blbk" + "FJ" + a(20)],
    ["anthropic_api_key", "sk-ant-" + "api03-" + a(93) + "AA"],
  ];

  it.each(NEW_FORMAT_PROBES)("matches a %s-shaped value", (_name, probe) => {
    expect(FORBIDDEN_CONTENT.test(probe)).toBe(true);
  });

  // Every remaining HARD_SECRET_KIND, so the probe set below can be checked for COMPLETENESS rather than
  // trusted. These four predate #7433 and were previously asserted in prose-y one-off tests.
  const LEGACY_PROBES: Array<[string, string]> = [
    ["private_key_block", "-----BEGIN" + " RSA PRIVATE KEY" + "-----"],
    ["github_pat", "github_pat_" + a(22)],
    ["github_token", "ghp_" + a(30)],
    ["jwt", "eyJ" + A(20) + "." + a(20) + "." + a(20)],
  ];
  const ALL_PROBES = [...NEW_FORMAT_PROBES, ...LEGACY_PROBES];

  it("COMPLETENESS: every HARD_SECRET_KIND has a probe here — adding a 17th kind fails until it is mirrored", () => {
    // THE GAP THIS CLOSES: FORBIDDEN_CONTENT hand-copies its provider-key bodies out of SECRET_PATTERNS
    // (see the header of scripts/forbidden-content.ts for why the copy still exists). Nothing forced the
    // copy to keep up. A 17th entry added to HARD_SECRET_KINDS and forgotten here would leave every
    // PUBLISHED TARBALL unscanned for that shape while this whole file still passed green -- the exact
    // silent-rot failure mode validate-no-hand-written-js guards against with its stale-entry check.
    expect(new Set(ALL_PROBES.map(([kind]) => kind))).toEqual(HARD_SECRET_KINDS);
  });

  it.each(ALL_PROBES)("EQUIVALENCE: the canonical %s pattern and FORBIDDEN_CONTENT agree on the same value", (kind, probe) => {
    // The copy is allowed to be WIDER than canonical (it is, deliberately, for gh*/github_pat/private-key
    // blocks -- a tarball scanner should not require a 20-char floor or the `-----` delimiters). It must
    // never be NARROWER: a value the review lane hard-blocks must never sail into a published tarball.
    const canonical = SECRET_PATTERNS.find((pattern) => pattern.name === kind);
    expect(canonical, `no SECRET_PATTERNS entry named ${kind}`).toBeDefined();
    expect(canonical?.re.test(probe), `probe for ${kind} does not match its own canonical pattern`).toBe(true);
    expect(FORBIDDEN_CONTENT.test(probe), `FORBIDDEN_CONTENT is NARROWER than canonical for ${kind}`).toBe(true);
  });

  it("INVARIANT: the two shapes with no canonical home stay covered", () => {
    // `gts_*` (a loopover-issued token) and the `*_TOKEN=` env-assignment shape are intentionally NOT in
    // SECRET_PATTERNS -- the review lane treats generic assignments as advisory-only (see
    // ADVISORY_ONLY_SECRET_KINDS), but a tarball has no human to advise, so here they are hard blocks. This
    // pins that asymmetry as deliberate rather than leftover.
    expect(FORBIDDEN_CONTENT.test("gts_" + "0".repeat(64))).toBe(true);
    expect(FORBIDDEN_CONTENT.test("MY" + "_TOKEN=" + "x")).toBe(true);
    expect(SECRET_PATTERNS.some((pattern) => pattern.name === "gts_token")).toBe(false);
    expect(ADVISORY_ONLY_SECRET_KINDS.has("generic_secret_assignment")).toBe(true);
  });

  it("does NOT hard-block the deliberately-excluded weak heuristics (seed / bittensor key shapes)", () => {
    // These remain out of the packaged-secret hard block — ordinary Bittensor coldkey/hotkey
    // mentions or a mnemonic word are not leaked credentials.
    expect(FORBIDDEN_CONTENT.test("coldkey: my-wallet-name")).toBe(false);
    expect(FORBIDDEN_CONTENT.test("the recovery mnemonic is stored offline")).toBe(false);
    expect(FORBIDDEN_CONTENT.global).toBe(false);
  });
});
