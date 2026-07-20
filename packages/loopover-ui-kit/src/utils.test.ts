import { describe, expect, it } from "vitest";
import { cn, relativeTimeFromNow } from "./utils";

describe("cn", () => {
  it("merges class names and lets a later Tailwind class win a conflict (tailwind-merge)", () => {
    expect(cn("px-2", "text-sm")).toBe("px-2 text-sm");
    // tailwind-merge dedupes conflicting utilities, keeping the last one.
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("drops falsy/conditional entries (clsx)", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
    expect(cn("base", { active: true, hidden: false })).toBe("base active");
  });
});

// Ported verbatim from apps/loopover-ui/src/components/site/refresh-meta.test.tsx (#2219) so the two suites
// can't drift, plus the future-clock-skew clamp the issue (#7437) calls out explicitly.
describe("relativeTimeFromNow (#2219)", () => {
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);

  it("labels each bucket at and around its boundary", () => {
    // seconds bucket, including the exact lower edge and the last second before a minute
    expect(relativeTimeFromNow(now, now)).toBe("just now");
    expect(relativeTimeFromNow(now - 59_000, now)).toBe("just now");
    // minutes bucket: 60s flips to 1m; 59m59s still reads 59m
    expect(relativeTimeFromNow(now - MINUTE_MS, now)).toBe("1m ago");
    expect(relativeTimeFromNow(now - (HOUR_MS - 1000), now)).toBe("59m ago");
    // hours bucket: 60m flips to 1h; 23h59m still reads 23h
    expect(relativeTimeFromNow(now - HOUR_MS, now)).toBe("1h ago");
    expect(relativeTimeFromNow(now - (DAY_MS - MINUTE_MS), now)).toBe("23h ago");
    // days bucket: 24h flips to 1d and keeps counting
    expect(relativeTimeFromNow(now - DAY_MS, now)).toBe("1d ago");
    expect(relativeTimeFromNow(now - 3 * DAY_MS - 2 * HOUR_MS, now)).toBe("3d ago");
  });

  it("clamps a future (clock-skewed) timestamp to 'just now' instead of a negative age", () => {
    expect(relativeTimeFromNow(now + 5_000, now)).toBe("just now");
    expect(relativeTimeFromNow(now + DAY_MS, now)).toBe("just now");
  });
});
