import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content.js";

// forbidden-content.ts calls itself the single source of truth for the packaged secret-shape detector, but
// nothing enforced it: check-mcp-package.mjs re-declared the regex as its own local constant and the two could
// drift apart unnoticed (#6290). These assertions pin both halves of the claim -- the structural one (each
// checker imports the constant rather than owning a copy) and the behavioral one (each checker actually rejects
// what the shared detector matches).
const PACKAGE_CHECKERS = ["scripts/check-miner-package.mjs", "scripts/check-mcp-package.mjs"];

// A minimal file list that passes each checker's path/allowlist/required-file guards, so the run reaches the
// shared secret-content read. Mirrors the file lists each checker's own "rejects secret-like content" test uses.
const REACHABLE_FILES: Record<string, string[]> = {
  "scripts/check-miner-package.mjs": ["package.json", "bin/loopover-miner.js", "lib/cli.js"],
  "scripts/check-mcp-package.mjs": ["package.json", "bin/loopover-mcp.js"],
};

// Assembled from fragments so this file never itself contains a credential-shaped literal -- the same
// convention check-mcp-package.test.ts and check-miner-package.test.ts already use for their probes.
const SECRET_SHAPED_PROBE = ["PROBE", "_", "SECRET", "=", "value"].join("");

// Run a checker as a subprocess (never import it): both scripts run `npm pack` at import time, and neither has a
// .d.mts, so importing them from TS would also break the typecheck gate. Their env seams let a single file drive
// the whole file list + content. Run via tsx, not plain node: both scripts import forbidden-content.ts (and
// check-mcp-package.mjs also imports mcp-package-allowlist.ts) directly, so plain node can't resolve those
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
    expect(source).toContain('import { FORBIDDEN_CONTENT } from "./forbidden-content.js";');
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
  it("scripts/check-mcp-package.mjs accepts content the shared detector leaves alone", () => {
    const result = runChecker(
      "scripts/check-mcp-package.mjs",
      REACHABLE_FILES["scripts/check-mcp-package.mjs"]!,
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

  it("still matches the pre-existing shapes (private-key block, github_pat, gh*, gts, generic assignment)", () => {
    expect(FORBIDDEN_CONTENT.test("BEGIN RSA PRIVATE KEY")).toBe(true);
    expect(FORBIDDEN_CONTENT.test("github_pat_" + a(20))).toBe(true);
    expect(FORBIDDEN_CONTENT.test("ghp_" + a(30))).toBe(true);
    expect(FORBIDDEN_CONTENT.test("gts_" + "0".repeat(64))).toBe(true);
    expect(FORBIDDEN_CONTENT.test("MY" + "_TOKEN=" + "x")).toBe(true);
  });

  it("does NOT hard-block the deliberately-excluded weak heuristics (jwt / seed / bittensor key shapes)", () => {
    // These are intentionally kept out of the packaged-secret hard block (#7433) — an ordinary Bittensor
    // coldkey/hotkey mention or a mnemonic word is not a leaked credential; a bare JWT is out of scope.
    expect(FORBIDDEN_CONTENT.test("coldkey: my-wallet-name")).toBe(false);
    expect(FORBIDDEN_CONTENT.test("the recovery mnemonic is stored offline")).toBe(false);
    // A bare header-dot-payload JWT shape is not matched by the hard-block detector.
    expect(FORBIDDEN_CONTENT.test("eyJ" + A(20) + "." + a(20) + "." + a(20))).toBe(false);
    expect(FORBIDDEN_CONTENT.global).toBe(false);
  });
});
