#!/usr/bin/env node
// A test fixture must not re-read the clock per timestamp (#9955).
//
// THE BUG THIS CATCHES, in the exact shape that reached CI. `test/unit/queue-trends.test.ts` had:
//
//   function atDaysAgo(daysAgo: number) { return new Date(Date.now() - daysAgo * 864e5).toISOString(); }
//
// Every call re-read the clock, so two timestamps in ONE fixture were mutually inconsistent by however long
// elapsed between the calls. The code under test anchors its window on the newest snapshot:
//
//   targetMs = latestMs - windowDays * day
//   baseline = newest snapshot with fetchedAt <= targetMs
//
// `atDaysAgo(0)` evaluated at T0 and `atDaysAgo(7)` a moment later at T1 put the "7 days ago" row at T1-7d --
// NEWER than the target T0-7d. No baseline, every window "unavailable", assertion fails. It passed only when
// both calls landed in the same millisecond. Reproduced deterministically with a 2ms offset.
//
// WHY IT IS WORTH A CHECKER. Reviews here are one-shot for everyone but the maintainer. A false red on a
// contributor PR is not a re-run away from fine -- it auto-closes correct work, and the contributor cannot
// reopen. A fixture that fails on timing alone is therefore a gate-correctness problem, not CI noise. It
// surfaced on #9950, whose only changed file was a GitHub workflow.
//
// WHAT IS ALLOWED. Reading the clock live is correct when the passage of time IS the thing under test --
// a polling `waitFor(predicate)`, or a lock-expiry helper comparing against `Date.now()`. Those take no
// offset parameter to project a fixture time from, which is exactly how this check tells them apart: it
// only reports helpers that take an OFFSET and derive a timestamp from a freshly-read clock.
//
// THE FIX is always the same: capture one instant per file and derive every fixture timestamp from it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

export type FixtureClockRace = { file: string; helper: string; calls: number };

/** Every directory whose fixtures the checker walks. `packages/loopover-engine/test` is a second,
 *  independently-run required suite (`npm run test --workspace @loopover/engine`) with its own convention
 *  for this bug shape, and is scanned alongside the root suite so a violation there fails the same way. */
export const FIXTURE_TEST_ROOTS = ["test", "packages/loopover-engine/test"] as const;

/** Helper declarations of the racy shape: takes an offset parameter AND computes from a fresh `Date.now()`. */
const OFFSET_HELPER_RE = /(?:^|\n)\s*(?:export\s+)?(?:function\s+(\w+)\s*\(([^)]*)\)|const\s+(\w+)\s*=\s*\(([^)]*)\)\s*(?::[^=]+)?=>)/g;

/**
 * PURE: every offset-taking fixture helper in `source` that derives a timestamp from a freshly-read clock and
 * is called more than once. One call cannot be inconsistent with itself, so a single-use helper is not a race
 * -- it takes two timestamps from two clock reads for the bug to exist.
 */
export function findFixtureClockRaces(file: string, source: string): FixtureClockRace[] {
  const races: FixtureClockRace[] = [];
  for (const match of source.matchAll(OFFSET_HELPER_RE)) {
    const name = match[1] ?? match[3];
    const params = match[2] ?? match[4];
    if (!name || !params || params.trim() === "") continue;
    // The helper's body: from its declaration to the next blank line at column 0, which is where every
    // top-level declaration in these files ends. Deliberately crude -- a false NEGATIVE here just means the
    // check misses one, while a parser dependency for a lint rule would be worse.
    const start = match.index ?? 0;
    const body = source.slice(start, start + 400);
    if (!/Date\.now\(\)/.test(body)) continue;
    // The offset must come FROM THE PARAMETER. `Date.now() - days * 86_400_000` projects a fixture time and is
    // the racy shape; `Date.now() + 60 * 60_000` (a token expiry an hour out) and `expiresAt <= Date.now()`
    // (a liveness check) are not -- neither derives its offset from an argument the caller varies per call.
    // Without this the check flags any helper that merely happens to mention the clock, and a checker that
    // cries wolf gets muted, which is worse than not having one.
    const parameterNames = params
      .split(",")
      .map((parameter) => /(\w+)\s*[:=)]?/.exec(parameter.trim())?.[1])
      .filter((parameter): parameter is string => Boolean(parameter));
    const projectsFromParameter = parameterNames.some((parameter) =>
      // The span between the operator and the parameter must stay inside ONE arithmetic expression: `,`, `)`
      // and `}` end it. Allowing them let `Date.now() + 60 * 60_000, body` reach an unrelated `body`
      // identifier two fields later and report a token-expiry helper as a fixture race.
      new RegExp(`Date\\.now\\(\\)\\s*[-+][^;\\n,)}]*\\b${parameter}\\b`).test(body),
    );
    if (!projectsFromParameter) continue;
    // Count CALL SITES. `function name(` itself matches the call shape and must be subtracted; the arrow form
    // `const name = (` does not, and subtracting there undercounted every arrow helper by one -- which silently
    // exempted the exactly-two-call case, the smallest set that can actually race.
    const declarationLooksLikeACall = Boolean(match[1]);
    const calls = [...source.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))].length - (declarationLooksLikeACall ? 1 : 0);
    // One report per helper: the declaration regex can match a single helper twice (its `function` and
    // arrow forms overlap on some shapes), and reporting the same name twice reads as two problems.
    if (calls >= 2 && !races.some((race) => race.helper === name)) races.push({ file, helper: name, calls });
  }
  return races;
}

/** Recursively collects `*.test.ts` files under `dir` into `out`, tolerating a missing directory (a checkout
 *  without the engine package must still run rather than crash). Exported so the roots loop's tolerance and
 *  reach can be asserted directly rather than only through `main()`'s unmockable filesystem paths. */
export function walk(dir: string, out: string[]): void {
  let entries: ReadonlyArray<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(path, out);
      // The checker-testing files (check-*-script.test.ts) embed the very pattern under test inside fixture
      // STRING LITERALS, exactly as check-turbo-typecheck-inputs.ts's own fixtures do. Those are not real
      // fixtures and flagging them would make this checker permanently red on its own test suite.
    } else if (entry.name.endsWith(".test.ts") && !/^check-.*-script\.test\.ts$/.test(entry.name)) out.push(path);
  }
}

function main(): void {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const files: string[] = [];
  for (const testRoot of FIXTURE_TEST_ROOTS) walk(join(root, testRoot), files);

  const races = files.flatMap((file) => findFixtureClockRaces(file.slice(root.length + 1), readFileSync(file, "utf8")));
  if (races.length > 0) {
    console.error("Fixture helpers re-read the clock per timestamp, which is a race:\n");
    for (const race of races) console.error(`  ${race.file}  ${race.helper}()  (${race.calls} calls)`);
    console.error(
      "\n  Two timestamps built from two Date.now() reads are mutually inconsistent by the time elapsed between\n" +
        "  them. Where the code under test compares them against a boundary derived from one of them, a single\n" +
        "  millisecond flips the result -- a false-positive red CI, which under one-shot review auto-closes\n" +
        "  correct contributor work.\n\n" +
        "  Fix: capture one instant per file and derive every fixture timestamp from it:\n" +
        "      const FIXTURE_NOW_MS = Date.now();\n" +
        "      const daysAgo = (d: number) => new Date(FIXTURE_NOW_MS - d * 86_400_000).toISOString();\n\n" +
        "  Reading the clock live is still correct where the passage of time IS under test (a polling waitFor,\n" +
        "  a lock-expiry check) -- those take no offset to project from, and are not reported.",
    );
    process.exit(1);
  }
  console.log(`fixture-clock-races: OK — ${files.length} test files, no offset helper re-reads the clock.`);
}

if (process.argv[1]?.endsWith("check-fixture-clock-races.ts")) main();
