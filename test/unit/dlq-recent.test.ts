import { afterEach, describe, expect, it, vi } from "vitest";
import * as repositories from "../../src/db/repositories";
import { DLQ_RECENT_WINDOW_MS, isoNowMinus, sampleRecentDeadLetters } from "../../src/selfhost/dlq-recent";

describe("dlq-recent gauge helpers (#2083)", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("isoNowMinus", () => {
    it("returns the ISO timestamp windowMs before the injected now", () => {
      const now = Date.parse("2026-07-04T12:00:00.000Z");
      expect(isoNowMinus(15 * 60 * 1000, now)).toBe("2026-07-04T11:45:00.000Z");
    });

    it("defaults to the current clock when no now is given", () => {
      // Default-parameter path: a window before "now" is always in the past.
      expect(isoNowMinus(1000) <= new Date().toISOString()).toBe(true);
    });

    it("exposes a 15-minute default window", () => {
      expect(DLQ_RECENT_WINDOW_MS).toBe(900_000);
    });
  });

  describe("sampleRecentDeadLetters", () => {
    it("returns the count over the trailing window, queried at the window start", async () => {
      const now = Date.parse("2026-07-04T12:00:00.000Z");
      const spy = vi.spyOn(repositories, "countRecentDeadLetters").mockResolvedValue(7);
      expect(await sampleRecentDeadLetters({} as Env, now)).toBe(7);
      expect(spy).toHaveBeenCalledWith({}, "2026-07-04T11:45:00.000Z");
    });

    it("degrades to 0 when the query throws, so a DB hiccup never breaks the scrape", async () => {
      vi.spyOn(repositories, "countRecentDeadLetters").mockRejectedValue(new Error("db down"));
      expect(await sampleRecentDeadLetters({} as Env)).toBe(0);
    });
  });
});
