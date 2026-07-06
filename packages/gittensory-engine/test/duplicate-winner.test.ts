import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isDuplicateClusterWinner,
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the duplicate-winner adjudication API", () => {
  assert.equal(typeof isDuplicateClusterWinner, "function");
  assert.equal(typeof isDuplicateClusterWinnerByClaim, "function");
  assert.equal(typeof resolveDuplicateClusterWinnerNumber, "function");
});

test("isDuplicateClusterWinner: the lowest open sibling number wins", () => {
  assert.equal(isDuplicateClusterWinner(5, [7, 9]), true);
});

test("isDuplicateClusterWinner: a lower open sibling beats this PR (loser)", () => {
  assert.equal(isDuplicateClusterWinner(5, [3, 9]), false);
});

test("isDuplicateClusterWinner: an empty sibling list is always a winner", () => {
  assert.equal(isDuplicateClusterWinner(5, []), true);
});

test("isDuplicateClusterWinnerByClaim: an empty sibling list is always a winner", () => {
  assert.equal(isDuplicateClusterWinnerByClaim({ number: 5 }, []), true);
});

test("isDuplicateClusterWinnerByClaim: elects the earliest observed linked-issue claimant, not the lowest PR number", () => {
  const earlier = { number: 9, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  const later = { number: 3, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  assert.equal(isDuplicateClusterWinnerByClaim(earlier, [later]), true);
  assert.equal(isDuplicateClusterWinnerByClaim(later, [earlier]), false);
});

test("isDuplicateClusterWinnerByClaim: falls back to PR number for an equal known claim timestamp", () => {
  const a = { number: 3, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  const b = { number: 9, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  assert.equal(isDuplicateClusterWinnerByClaim(a, [b]), true);
  assert.equal(isDuplicateClusterWinnerByClaim(b, [a]), false);
});

test("isDuplicateClusterWinnerByClaim: fails closed when sparse legacy rows lack claim timestamps", () => {
  assert.equal(isDuplicateClusterWinnerByClaim({ number: 5 }, [{ number: 9 }]), false);
});

test("isDuplicateClusterWinnerByClaim: fails closed on an invalid claim timestamp", () => {
  assert.equal(
    isDuplicateClusterWinnerByClaim({ number: 5, linkedIssueClaimedAt: "not-a-date" }, [{ number: 9, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" }]),
    false,
  );
});

test("isDuplicateClusterWinnerByClaim createdAt precedence: elects the PR GitHub says opened first, even when observed later", () => {
  const openedFirstButClaimedLater = {
    number: 9,
    createdAt: "2026-01-01T00:00:00Z",
    linkedIssueClaimedAt: "2026-01-05T00:00:00Z",
  };
  const openedSecondButClaimedFirst = {
    number: 3,
    createdAt: "2026-01-02T00:00:00Z",
    linkedIssueClaimedAt: "2026-01-01T00:00:00Z",
  };
  assert.equal(isDuplicateClusterWinnerByClaim(openedFirstButClaimedLater, [openedSecondButClaimedFirst]), true);
  assert.equal(isDuplicateClusterWinnerByClaim(openedSecondButClaimedFirst, [openedFirstButClaimedLater]), false);
});

test("isDuplicateClusterWinnerByClaim createdAt precedence: falls back to claim-time when only one side has a valid createdAt", () => {
  const modern = { number: 9, createdAt: "2026-01-01T00:00:00Z", linkedIssueClaimedAt: "2026-01-05T00:00:00Z" };
  const legacy = { number: 3, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  // Neither side has BOTH createdAt values, so this falls back to claim-time comparison: modern claimed later, so legacy wins.
  assert.equal(isDuplicateClusterWinnerByClaim(legacy, [modern]), true);
  assert.equal(isDuplicateClusterWinnerByClaim(modern, [legacy]), false);
});

test("isDuplicateClusterWinnerByClaim createdAt precedence: ties break by PR number", () => {
  const a = { number: 3, createdAt: "2026-01-01T00:00:00Z" };
  const b = { number: 9, createdAt: "2026-01-01T00:00:00Z" };
  assert.equal(isDuplicateClusterWinnerByClaim(a, [b]), true);
  assert.equal(isDuplicateClusterWinnerByClaim(b, [a]), false);
});

test("resolveDuplicateClusterWinnerNumber: returns this PR's own number when it is the winner", () => {
  const pr = { number: 5, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  const sibling = { number: 9, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  assert.equal(resolveDuplicateClusterWinnerNumber(pr, [sibling]), 5);
});

test("resolveDuplicateClusterWinnerNumber: returns the actual winning sibling's number when this PR is a loser", () => {
  const pr = { number: 9, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  const sibling = { number: 5, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  assert.equal(resolveDuplicateClusterWinnerNumber(pr, [sibling]), 5);
});

test("resolveDuplicateClusterWinnerNumber: an empty sibling list means this PR wins by default", () => {
  assert.equal(resolveDuplicateClusterWinnerNumber({ number: 5 }, []), 5);
});

test("resolveDuplicateClusterWinnerNumber: returns null when the election is too ambiguous to name a specific winner", () => {
  // Every member lacks a claim timestamp, so no one can be proven the winner (fails closed).
  assert.equal(resolveDuplicateClusterWinnerNumber({ number: 5 }, [{ number: 9 }, { number: 3 }]), null);
});
