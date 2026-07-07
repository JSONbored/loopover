import { describe, expect, it } from "vitest";
import { bandFromMinutes, estimateReviewEffort, type ReviewEffortFile } from "../../src/review/review-effort";

// A patch with exactly `added` added lines (each `+`), so a test can dial the effort precisely.
function srcPatch(added: number): string {
  return ["@@ -0,0 +1," + added + " @@", ...Array.from({ length: added }, (_, i) => `+const x${i} = ${i};`)].join("\n");
}

function file(path: string, added: number): ReviewEffortFile {
  return { path, patch: srcPatch(added) };
}

describe("estimateReviewEffort (#2151)", () => {
  it("returns band 1 and a floored minute for an empty change set", () => {
    expect(estimateReviewEffort([])).toEqual({ band: 1, minutes: 1 });
  });

  it("counts a file with no patch as zero added lines but still charges per-file overhead", () => {
    // one file, no patch: weighted 0 + 1*3 = effort 3 -> band 1, minutes round(1.5) = 2
    expect(estimateReviewEffort([{ path: "src/a.ts" }])).toEqual({ band: 1, minutes: 2 });
  });

  it("maps rising source-line volume across every band", () => {
    expect(estimateReviewEffort([file("src/a.ts", 2)]).band).toBe(1); // effort 5
    expect(estimateReviewEffort([file("src/a.ts", 20)]).band).toBe(2); // effort 23
    expect(estimateReviewEffort([file("src/a.ts", 60)]).band).toBe(3); // effort 63
    expect(estimateReviewEffort([file("src/a.ts", 200)]).band).toBe(4); // effort 203
    expect(estimateReviewEffort([file("src/a.ts", 400)]).band).toBe(5); // effort 403
  });

  it("derives minutes as half the weighted effort", () => {
    // 400 source lines -> weighted 400 + 3 = 403 -> round(201.5) = 202
    expect(estimateReviewEffort([file("src/a.ts", 400)]).minutes).toBe(202);
  });

  it("weights non-source categories below source, so the same line count reviews as less effort", () => {
    const source = estimateReviewEffort([file("src/a.ts", 100)]); // 100 + 3 = 103 -> band 3
    const docs = estimateReviewEffort([file("docs/guide.md", 100)]); // 25 + 3 = 28 -> band 2
    const lockfile = estimateReviewEffort([file("package-lock.json", 100)]); // 10 + 3 = 13 -> band 2
    expect(source.band).toBe(3);
    expect(docs.band).toBe(2);
    expect(lockfile.band).toBe(2);
    expect(docs.minutes).toBeLessThan(source.minutes);
    expect(lockfile.minutes).toBeLessThan(docs.minutes);
  });

  it("sums weighted effort across multiple files", () => {
    const effort = estimateReviewEffort([file("src/a.ts", 10), file("src/b.ts", 10)]); // (10+10) + 2*3 = 26 -> band 2
    expect(effort.band).toBe(2);
    expect(effort.minutes).toBe(13);
  });

  it("maps a multi-file change above the band-4 ceiling to band 5 (#2151)", () => {
    // BAND_MAX top tier is 300; 5×100 source lines + 5×3 per-file overhead = 515 → band 5
    const files = Array.from({ length: 5 }, (_, i) => file(`src/pkg${i}/mod.ts`, 100));
    expect(estimateReviewEffort(files)).toEqual({ band: 5, minutes: 258 });
  });
});

describe("bandFromMinutes (#2155)", () => {
  it("maps persisted minutes back to the same band the estimator would have produced", () => {
    const samples = [
      estimateReviewEffort([]),
      estimateReviewEffort([file("src/a.ts", 20)]),
      estimateReviewEffort([file("src/a.ts", 200)]),
      estimateReviewEffort([file("src/a.ts", 400)]),
    ];
    for (const sample of samples) {
      expect(bandFromMinutes(sample.minutes)).toBe(sample.band);
    }
  });
});
