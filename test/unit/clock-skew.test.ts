import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockSkewSecondsSample, recordClockSkewFromResponse, resetClockSkewForTest } from "../../src/selfhost/clock-skew";

beforeEach(() => resetClockSkewForTest());
afterEach(() => vi.useRealTimers());

describe("clock-skew", () => {
  it("defaults to 0 before any sample is recorded", () => {
    expect(clockSkewSecondsSample()).toBe(0);
  });

  it("records a positive skew when the local clock is ahead of the response's Date header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    const response = new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } });
    recordClockSkewFromResponse(response);
    expect(clockSkewSecondsSample()).toBe(300); // 5 minutes ahead
  });

  it("records a negative skew when the local clock is behind the response's Date header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    const response = new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:02:00 GMT" } });
    recordClockSkewFromResponse(response);
    expect(clockSkewSecondsSample()).toBe(-120); // 2 minutes behind
  });

  it("ignores a response with no Date header, leaving the prior sample in place", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    expect(clockSkewSecondsSample()).toBe(300);

    recordClockSkewFromResponse(new Response(null));
    expect(clockSkewSecondsSample()).toBe(300); // unchanged, not reset to 0
  });

  it("ignores an unparseable Date header, leaving the prior sample in place", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    expect(clockSkewSecondsSample()).toBe(300);

    recordClockSkewFromResponse(new Response(null, { headers: { date: "not-a-date" } }));
    expect(clockSkewSecondsSample()).toBe(300); // unchanged, not reset to 0
  });

  it("resetClockSkewForTest restores the sample to 0", () => {
    recordClockSkewFromResponse(new Response(null, { headers: { date: new Date(Date.now() - 60_000).toUTCString() } }));
    expect(clockSkewSecondsSample()).not.toBe(0);
    resetClockSkewForTest();
    expect(clockSkewSecondsSample()).toBe(0);
  });
});
