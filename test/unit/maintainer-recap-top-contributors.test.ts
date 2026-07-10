import { describe, expect, it } from "vitest";
import {
  buildTopContributorsRecapSection,
  type TopContributorsRecapSource,
} from "../../src/services/maintainer-recap-top-contributors";

const WINDOW = 7;

function source(
  contributors: TopContributorsRecapSource["contributors"],
  windowDays = WINDOW,
): TopContributorsRecapSource {
  return { windowDays, contributors };
}

describe("buildTopContributorsRecapSection (#2244)", () => {
  it("sorts by merged descending and emits count-only lines", () => {
    const section = buildTopContributorsRecapSection(
      source([
        { login: "alice", merged: 2 },
        { login: "bob", merged: 9 },
        { login: "carol", merged: 5 },
      ]),
    );
    expect(section.title).toBe("Top contributors");
    expect(section.rows.map((r) => r.login)).toEqual(["bob", "carol", "alice"]);
    expect(section.dropped).toBe(0);
    expect(section.lines).toEqual(["bob: 9 merged", "carol: 5 merged", "alice: 2 merged"]);
  });

  it("breaks a merged-count tie by login ascending (deterministic — localeCompare arm)", () => {
    const section = buildTopContributorsRecapSection(
      source([
        { login: "zoe", merged: 4 },
        { login: "amy", merged: 4 },
        { login: "max", merged: 4 },
      ]),
    );
    expect(section.rows.map((r) => r.login)).toEqual(["amy", "max", "zoe"]);
  });

  it("caps the leaderboard at the given limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ login: `u${i}`, merged: 100 - i }));
    const section = buildTopContributorsRecapSection(source(many), 3);
    expect(section.rows).toHaveLength(3);
    expect(section.rows.map((r) => r.login)).toEqual(["u0", "u1", "u2"]);
    expect(section.lines).toHaveLength(3);
  });

  it("keeps public-safe logins and DROPS ones whose line carries a reward/score term (both gate arms)", () => {
    const section = buildTopContributorsRecapSection(
      source([
        { login: "honest-dev", merged: 7 },
        { login: "reward-farm", merged: 99 }, // "reward" ⇒ isPublicSafeText false ⇒ dropped
        { login: "score-bot", merged: 50 }, // "score" ⇒ dropped
      ]),
    );
    expect(section.dropped).toBe(2);
    expect(section.rows.map((r) => r.login)).toEqual(["honest-dev"]);
    for (const line of section.lines) {
      expect(line).not.toMatch(/reward|score/i);
    }
  });

  it("emits a no-activity line when nothing survives (empty input, all-dropped, and non-positive limit arms)", () => {
    expect(buildTopContributorsRecapSection(source([])).lines).toEqual([
      "No contributor activity in the last 7 day(s).",
    ]);
    // all contributors dropped by the public-safe gate ⇒ still the empty arm
    const allUnsafe = buildTopContributorsRecapSection(source([{ login: "payout-king", merged: 3 }]));
    expect(allUnsafe.rows).toEqual([]);
    expect(allUnsafe.dropped).toBe(1);
    expect(allUnsafe.lines).toEqual(["No contributor activity in the last 7 day(s)."]);
    // a non-positive limit yields an empty leaderboard (Math.max(0, limit) arm)
    const zeroLimit = buildTopContributorsRecapSection(source([{ login: "alice", merged: 1 }]), 0);
    expect(zeroLimit.rows).toEqual([]);
    expect(zeroLimit.lines).toEqual(["No contributor activity in the last 7 day(s)."]);
  });

  it("defaults the limit to 8 when the caller omits it", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ login: `c${i}`, merged: 20 - i }));
    const section = buildTopContributorsRecapSection(source(nine));
    expect(section.rows).toHaveLength(8);
  });
});
