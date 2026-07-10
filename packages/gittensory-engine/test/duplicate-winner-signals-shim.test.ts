import { test } from "node:test";
import assert from "node:assert/strict";

import * as topLevel from "../dist/duplicate-winner.js";
import * as signalsShim from "../dist/signals/duplicate-winner.js";

test("signals/duplicate-winner is a thin re-export of the top-level module (#4251)", () => {
  assert.equal(signalsShim.isDuplicateClusterWinner, topLevel.isDuplicateClusterWinner);
  assert.equal(signalsShim.isDuplicateClusterWinnerByClaim, topLevel.isDuplicateClusterWinnerByClaim);
  assert.equal(
    signalsShim.resolveDuplicateClusterWinnerNumber,
    topLevel.resolveDuplicateClusterWinnerNumber,
  );
});

test("signals/duplicate-winner: isDuplicateClusterWinnerByClaim still behaves correctly through the shim (advisory/gate-advisory.ts's import path)", () => {
  const winner = { number: 5, linkedIssueClaimedAt: "2026-01-01T00:00:00Z" };
  const laterSibling = { number: 7, linkedIssueClaimedAt: "2026-01-02T00:00:00Z" };
  assert.equal(signalsShim.isDuplicateClusterWinnerByClaim(winner, [laterSibling]), true);
  assert.equal(signalsShim.isDuplicateClusterWinnerByClaim(laterSibling, [winner]), false);
});
