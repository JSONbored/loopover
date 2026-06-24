import { describe, expect, it } from "vitest";
import { isDuplicateClusterWinner } from "../../src/signals/duplicate-winner";
import { dupWinnerLinkedDuplicateCount } from "../../src/queue/processors";

describe("isDuplicateClusterWinner (#dup-winner)", () => {
  it("the lowest open sibling number wins", () => {
    expect(isDuplicateClusterWinner(12, [13, 14])).toBe(true);
  });

  it("a lower open sibling beats this PR (loser)", () => {
    expect(isDuplicateClusterWinner(14, [12, 13])).toBe(false);
  });

  it("an empty sibling list ⇒ winner (alone in/out of the cluster)", () => {
    expect(isDuplicateClusterWinner(7, [])).toBe(true);
  });

  it("a sibling list that contains self is still min-based (winner when self is lowest)", () => {
    expect(isDuplicateClusterWinner(12, [12, 13])).toBe(true);
  });

  it("a sibling list that contains self plus a lower sibling ⇒ loser", () => {
    expect(isDuplicateClusterWinner(13, [12, 13])).toBe(false);
  });

  it("cascade: once the lowest sibling closes (drops out of the open set), the next-lowest becomes the winner", () => {
    // Cluster {12, 13, 14}. PR 13 is a loser while 12 is still open.
    expect(isDuplicateClusterWinner(13, [12, 14])).toBe(false);
    // PR 12 closes (red CI) → it leaves the OPEN sibling set the caller passes. Re-eval of PR 13 now sees only
    // {14} as the open sibling → 13 is the new winner. No permanently-orphaned cluster.
    expect(isDuplicateClusterWinner(13, [14])).toBe(true);
  });
});

describe("dupWinnerLinkedDuplicateCount (#dup-winner close-reason seam)", () => {
  it("winner + flag ON ⇒ 0 (close reason omits the duplicate cause)", () => {
    expect(dupWinnerLinkedDuplicateCount([13, 14], 12, true)).toBe(0);
  });

  it("loser + flag ON ⇒ real sibling count (close reason includes the duplicate cause)", () => {
    expect(dupWinnerLinkedDuplicateCount([12, 13], 14, true)).toBe(2);
  });

  it("flag OFF ⇒ real sibling count even for a would-be winner (byte-identical)", () => {
    expect(dupWinnerLinkedDuplicateCount([13, 14], 12, false)).toBe(2);
  });

  it("no siblings ⇒ 0 regardless of the flag", () => {
    expect(dupWinnerLinkedDuplicateCount([], 12, true)).toBe(0);
    expect(dupWinnerLinkedDuplicateCount([], 12, false)).toBe(0);
  });
});
