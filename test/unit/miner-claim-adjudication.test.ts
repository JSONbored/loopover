import { describe, expect, it } from "vitest";
import { adjudicateSoftClaim, toClaimMember } from "../../packages/gittensory-miner/lib/claim-adjudication.js";

describe("miner soft-claim adjudication (#4291)", () => {
  it("toClaimMember maps claimedAt → linkedIssueClaimedAt (the field names deliberately differ)", () => {
    expect(toClaimMember({ number: 7, claimedAt: "2026-01-01T00:00:00Z" })).toEqual({
      number: 7,
      linkedIssueClaimedAt: "2026-01-01T00:00:00Z",
    });
    // a missing claim time maps to null (fail-closed input), not undefined
    expect(toClaimMember({ number: 7 })).toEqual({ number: 7, linkedIssueClaimedAt: null });
  });

  it("this miner WINS when it claimed earliest", () => {
    const result = adjudicateSoftClaim(
      { number: 5, claimedAt: "2026-01-01T00:00:00Z" },
      [{ number: 6, claimedAt: "2026-01-02T00:00:00Z" }],
    );
    expect(result).toEqual({ isWinner: true, winnerNumber: 5 });
  });

  it("this miner LOSES to an earlier competing claim, and the winner is surfaced (display only)", () => {
    const result = adjudicateSoftClaim(
      { number: 6, claimedAt: "2026-01-02T00:00:00Z" },
      [{ number: 5, claimedAt: "2026-01-01T00:00:00Z" }],
    );
    expect(result).toEqual({ isWinner: false, winnerNumber: 5 });
  });

  it("no competing claim ⇒ trivial winner (even with an unknown claim time)", () => {
    expect(adjudicateSoftClaim({ number: 9, claimedAt: "2026-03-01T00:00:00Z" }, [])).toEqual({
      isWinner: true,
      winnerNumber: 9,
    });
    expect(adjudicateSoftClaim({ number: 9 }, [])).toEqual({ isWinner: true, winnerNumber: 9 });
  });

  it("fail-closed: a missing/sparse claim time loses AND yields no guessed winner", () => {
    // this miner has no observed claim time → cannot be elected, and (because the election needs BOTH members'
    // times to order them) no winner is determinable either — the engine never guesses when data is too sparse.
    expect(adjudicateSoftClaim({ number: 6 }, [{ number: 5, claimedAt: "2026-01-01T00:00:00Z" }])).toEqual({
      isWinner: false,
      winnerNumber: null,
    });
    // BOTH sides sparse → still no determinable winner
    expect(adjudicateSoftClaim({ number: 6 }, [{ number: 5 }])).toEqual({ isWinner: false, winnerNumber: null });
  });
});
