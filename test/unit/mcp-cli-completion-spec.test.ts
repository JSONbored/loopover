import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run } from "./support/mcp-cli-harness";

// #6260: CLI_COMMAND_SPEC's `cache` entry read ["status", "clear"] while runCacheCli has always accepted
// `list`/`ls` too. That single stale entry is the sole source for buildBash/Zsh/Fish/PowershellCompletion AND
// suggestCommand's typo-suggester, so tab-completion for `cache list` silently did nothing across all four
// shells — while `status`/`clear` completed fine, which is exactly why it went unnoticed.
//
// Pinning only "cache list completes" would fix today's miss and let the next entry rot the same way. So this
// asserts the INVARIANT instead: every canonical subcommand a run*Cli really accepts must appear in the spec.
// The source is parsed rather than imported because bin/loopover-mcp.js is an executable entrypoint that starts
// a server on import — reading it is how a test can inspect the spec without launching one.
const SOURCE = readFileSync(join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js"), "utf8");

/** The declared spec, read out of the committed source. */
function declaredSpec(): Record<string, string[]> {
  const block = /const CLI_COMMAND_SPEC = \{([\s\S]*?)\n\};/.exec(SOURCE)?.[1] ?? "";
  const spec: Record<string, string[]> = {};
  for (const match of block.matchAll(/^\s*"?([a-z-]+)"?:\s*\[([^\]]*)\],/gm)) {
    const name = match[1]!;
    const rawSubs = match[2]!;
    spec[name] = [...rawSubs.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }
  return spec;
}

/** Every `subcommand === "x"` a handler really accepts — excluding help and any `--flag` form. */
function acceptedBy(fnPattern: RegExp): string[] {
  const start = fnPattern.exec(SOURCE);
  if (!start) throw new Error(`handler not found: ${fnPattern}`);
  const rest = SOURCE.slice(start.index + start[0].length);
  const end = /\n(?:async )?function /.exec(rest);
  const body = rest.slice(0, end ? end.index : 5000);
  const accepted = new Set([...body.matchAll(/subcommand === "([a-z-]+)"/g)].map((m) => m[1]!));
  // `help`/`--help` are handled by every command and are not completable subcommands.
  for (const sub of [...accepted]) if (sub === "help" || sub.startsWith("-")) accepted.delete(sub);
  return [...accepted];
}

// Canonical name → the aliases the handler also accepts. The spec deliberately lists CANONICAL names only:
// `profile` accepts ls/use/rm/delete and `maintain` accepts pending, yet neither appears in their spec entry.
// Completing an alias is not the contract; completing every real subcommand is.
const ALIASES: Record<string, string[]> = {
  list: ["ls"],
  switch: ["use"],
  remove: ["rm", "delete"],
  queue: ["pending"],
};
const ALIAS_OF = new Map(Object.entries(ALIASES).flatMap(([canonical, aliases]) => aliases.map((a) => [a, canonical] as const)));

const HANDLERS: Array<{ command: string; fn: RegExp }> = [
  { command: "cache", fn: /(?:async )?function runCacheCli\([^)]*\)\s*\{/ },
  { command: "agent", fn: /(?:async )?function runAgentCli\([^)]*\)\s*\{/ },
  { command: "profile", fn: /(?:async )?function profileCommand\([^)]*\)\s*\{/ },
  { command: "maintain", fn: /(?:async )?function maintainCli\([^)]*\)\s*\{/ },
  { command: "telemetry", fn: /(?:async )?function telemetryCommand\([^)]*\)\s*\{/ },
];

describe("loopover-mcp CLI_COMMAND_SPEC ↔ implementation parity (#6260)", () => {
  it("REGRESSION: cache declares list, so `cache list` tab-completes like status/clear", () => {
    expect(declaredSpec().cache).toContain("list");
  });

  it.each(HANDLERS)("$command's spec declares every canonical subcommand its handler accepts", ({ command, fn }) => {
    const declared = declaredSpec()[command];
    expect(declared, `${command} must be in CLI_COMMAND_SPEC`).toBeDefined();

    const canonical = new Set(acceptedBy(fn).map((sub) => ALIAS_OF.get(sub) ?? sub));
    expect(canonical.size, `${command}'s handler must accept something`).toBeGreaterThan(0);
    for (const sub of canonical) {
      expect(declared, `${command} accepts "${sub}" — it must be completable`).toContain(sub);
    }
  });

  it.each(HANDLERS)("$command declares nothing its handler cannot actually run", ({ command, fn }) => {
    // The other direction: a spec entry for a removed subcommand would complete to a guaranteed error.
    const accepted = new Set(acceptedBy(fn));
    for (const sub of declaredSpec()[command] ?? []) {
      expect(accepted, `${command} completes "${sub}" — it must be handled`).toContain(sub);
    }
  });

  it("emits cache's subcommands into every shell's completion, not just bash", () => {
    // CLI_COMMAND_SPEC feeds all four builders, so the fix must land in all four.
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      const script = run(["completion", shell]);
      expect(script, `${shell} completion must offer cache list`).toMatch(/list/);
      expect(script, `${shell} completion must still offer cache status`).toMatch(/status/);
    }
  });

  it("suggests `list` for a typo'd cache subcommand, which the stale spec could never do", () => {
    // suggestCommand reads the same spec, so the stale entry silently degraded typo help too.
    expect(declaredSpec().cache).toEqual(expect.arrayContaining(["status", "clear", "list"]));
  });
});
