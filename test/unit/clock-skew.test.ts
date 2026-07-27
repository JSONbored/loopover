import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockSkewSampleAgeSeconds, clockSkewSecondsSample, recordClockSkewFromResponse, resetClockSkewForTest } from "../../src/selfhost/clock-skew";

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

describe("clock-skew sample age (#7000)", () => {
  it("ages from the reset/module-load time (not a flat -1) before any successful sample (#9128)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    resetClockSkewForTest(); // re-captures the boot-time reference under the fake clock
    expect(clockSkewSampleAgeSeconds()).toBe(0); // just reset -- no time has passed yet
    vi.setSystemTime(new Date("2026-07-06T12:10:00.000Z"));
    expect(clockSkewSampleAgeSeconds()).toBe(600); // 10 minutes later, still never sampled
  });

  it("reports the sample age in seconds after a successful sample, growing as time passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    expect(clockSkewSampleAgeSeconds()).toBe(0); // just sampled — no time has passed yet
    vi.setSystemTime(new Date("2026-07-06T12:05:30.000Z"));
    expect(clockSkewSampleAgeSeconds()).toBe(30); // 30s later, the same sample is now 30s old
  });

  it("does not advance the sample time when a response is ignored — age keeps growing from the last good sample", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    vi.setSystemTime(new Date("2026-07-06T12:01:00.000Z"));
    recordClockSkewFromResponse(new Response(null)); // no Date header — ignored, must not reset the sample time
    expect(clockSkewSampleAgeSeconds()).toBe(60); // still measured from the 12:00:00 sample, not "just now"
  });

  it("resetClockSkewForTest re-arms the never-sampled reference point to the moment of reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    expect(clockSkewSampleAgeSeconds()).toBe(300);
    resetClockSkewForTest();
    expect(clockSkewSampleAgeSeconds()).toBe(0); // never-sampled again, re-based at THIS moment, not -1
    vi.setSystemTime(new Date("2026-07-06T12:06:00.000Z"));
    expect(clockSkewSampleAgeSeconds()).toBe(60); // ages from the reset point, still never sampled
  });
});
