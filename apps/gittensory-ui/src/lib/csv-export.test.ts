import { describe, expect, it } from "vitest";

import { escapeCsvCell, operatorDashboardToCsvRows, toCsv } from "@/lib/csv-export";

describe("toCsv (#2198)", () => {
  it("returns an empty string for zero rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("serializes a normal row without quoting", () => {
    expect(
      toCsv([
        ["section", "key", "value", "detail"],
        ["metric", "Active actors", "42", "+3"],
      ]),
    ).toBe("section,key,value,detail\nmetric,Active actors,42,+3");
  });

  it("escapes quotes, commas, and newlines in every branch", () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(toCsv([["quoted", 'value,with"comma', "multi\nline"]])).toBe(
      'quoted,"value,with""comma","multi\nline"',
    );
  });
});

describe("operatorDashboardToCsvRows (#2198)", () => {
  it("flattens metrics and optional usage sections", () => {
    expect(
      operatorDashboardToCsvRows({
        metrics: [{ label: "Events", value: "10", delta: "+1" }],
        weeklyValueReport: {
          metrics: [{ id: "w1", label: "Weekly", value: 5, detail: "ok" }],
        },
        usageSummary: {
          byEvent: [{ eventName: "doctor", count: 2 }],
          bySurface: [{ surface: "cli", count: 1 }],
        },
      }),
    ).toEqual([
      ["section", "key", "value", "detail"],
      ["metric", "Events", "10", "+1"],
      ["weekly_value", "Weekly", "5", "ok"],
      ["usage_event", "doctor", "2", ""],
      ["usage_surface", "cli", "1", ""],
    ]);
  });
});
