// The fixture-clock-race checker must catch the real shape and stay quiet on the legitimate ones (#9955).
//
// A checker that cries wolf gets muted, and a muted checker is worse than no checker -- so the negative cases
// here matter as much as the positive one. Reading the clock live is CORRECT wherever the passage of time is
// itself under test; the distinguishing property is whether the helper projects a fixture timestamp from an
// offset its caller varies.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIXTURE_TEST_ROOTS, findFixtureClockRaces, walk } from "../../scripts/check-fixture-clock-races";

describe("findFixtureClockRaces (#9955)", () => {
  it("REGRESSION: catches the exact queue-trends shape that reached CI", () => {
    // Verbatim the helper that produced "expected 'unavailable' to be 'ready'" on #9950 -- a PR whose only
    // changed file was a GitHub workflow.
    const source = `
function atDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}
const a = atDaysAgo(0);
const b = atDaysAgo(7);
`;
    expect(findFixtureClockRaces("test/unit/x.test.ts", source)).toEqual([{ file: "test/unit/x.test.ts", helper: "atDaysAgo", calls: 2 }]);
  });

  it("catches the arrow form too, which is how most of these are written", () => {
    const source = `
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
seed(daysAgo(1));
seed(daysAgo(30));
`;
    expect(findFixtureClockRaces("f.test.ts", source).map((race) => race.helper)).toEqual(["daysAgo"]);
  });

  it("stays quiet once the file anchors on a single captured instant -- the fix must actually clear it", () => {
    const source = `
const FIXTURE_NOW_MS = Date.now();
const daysAgo = (days: number) => new Date(FIXTURE_NOW_MS - days * 86_400_000).toISOString();
seed(daysAgo(1));
seed(daysAgo(30));
`;
    expect(findFixtureClockRaces("f.test.ts", source)).toEqual([]);
  });

  it("does NOT flag a polling helper -- the passage of time is the thing it tests", () => {
    const source = `
function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return; }
}
await waitFor(() => a);
await waitFor(() => b);
`;
    expect(findFixtureClockRaces("f.test.ts", source)).toEqual([]);
  });

  it("does NOT flag a helper whose parameter has nothing to do with the clock", () => {
    // seedSelfHealingToken(body) mentions Date.now() for a token expiry an hour out. The offset is a
    // constant, not the caller's argument, so nothing varies between calls and there is no inconsistency.
    const source = `
function seedSelfHealingToken(body: unknown) {
  return { token: "t", expiresAtMs: Date.now() + 60 * 60_000, body };
}
seedSelfHealingToken({});
seedSelfHealingToken({ a: 1 });
`;
    expect(findFixtureClockRaces("f.test.ts", source)).toEqual([]);
  });

  it("does NOT flag a liveness comparison against the clock", () => {
    const source = `
const alive = (key: string) => {
  const entry = store.get(key);
  if (entry.expiresAtMs <= Date.now()) return null;
  return entry;
};
alive("a");
alive("b");
`;
    expect(findFixtureClockRaces("f.test.ts", source)).toEqual([]);
  });

  it("does NOT flag a single-use helper -- one call cannot disagree with itself", () => {
    const source = `
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
seed(daysAgo(1));
`;
    expect(findFixtureClockRaces("f.test.ts", source)).toEqual([]);
  });

  it("does NOT flag a zero-argument now() helper -- there is no offset to project from", () => {
    const source = `
const now = () => new Date(Date.now()).toISOString();
seed(now());
seed(now());
`;
    expect(findFixtureClockRaces("f.test.ts", source)).toEqual([]);
  });

  it("reports a helper ONCE even when its declaration matches more than one form", () => {
    const source = `
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
seed(dayAgo(1));
seed(dayAgo(2));
seed(dayAgo(3));
`;
    expect(findFixtureClockRaces("f.test.ts", source)).toHaveLength(1);
  });

  it("REGRESSION (#10043): reports the daysAgoIso shape that lived in packages/loopover-engine/test unscanned", () => {
    // Verbatim the pre-fix helper from packages/loopover-engine/test/issue-quality-report.test.ts, plus its
    // two call sites -- the exact shape the checker never saw because main() only walked test/.
    const source = `
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
const stale = build(daysAgoIso(60));
const ancient = build(daysAgoIso(100));
`;
    expect(findFixtureClockRaces("packages/loopover-engine/test/x.test.ts", source)).toEqual([
      { file: "packages/loopover-engine/test/x.test.ts", helper: "daysAgoIso", calls: 2 },
    ]);
  });
});

describe("FIXTURE_TEST_ROOTS and walk (#10043)", () => {
  it("scans both the root suite and the engine suite", () => {
    expect(FIXTURE_TEST_ROOTS).toContain("test");
    expect(FIXTURE_TEST_ROOTS).toContain("packages/loopover-engine/test");
  });

  it("walk tolerates a missing directory instead of throwing", () => {
    const out: string[] = [];
    expect(() => walk(join(tmpdir(), "check-fixture-clock-races-missing-dir-fixture"), out)).not.toThrow();
    expect(out).toEqual([]);
  });

  it("walk reaches a fixture under EITHER root the same way, mirroring main()'s per-root loop", () => {
    const workspace = mkdtempSync(join(tmpdir(), "fixture-clock-races-"));
    try {
      const rootTestDir = join(workspace, "test", "unit");
      const engineTestDir = join(workspace, "packages", "loopover-engine", "test");
      mkdirSync(rootTestDir, { recursive: true });
      mkdirSync(engineTestDir, { recursive: true });
      writeFileSync(join(rootTestDir, "root-fixture.test.ts"), "export const rootFixture = 1;\n");
      writeFileSync(join(engineTestDir, "engine-fixture.test.ts"), "export const engineFixture = 1;\n");

      const found: string[] = [];
      for (const testRoot of FIXTURE_TEST_ROOTS) walk(join(workspace, testRoot), found);

      expect(found).toContain(join(rootTestDir, "root-fixture.test.ts"));
      expect(found).toContain(join(engineTestDir, "engine-fixture.test.ts"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
