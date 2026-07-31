import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// #10174: the publish-and-maintain pass must claim the actuation lock BEFORE doing the work the lock exists
// to avoid duplicating.
//
// It used to refresh PR details first and ask "does another pass already own this?" second, so every
// contended pass paid for the refresh and threw it away. That was the single most frequent audit event on the
// production Orb -- 1,180 `github_app.pr_public_surface_lock_contended` in under two hours, about twice the
// next event -- and `refreshPullRequestDetails` is a GitHub read whenever the detail-sync cache misses, which
// is exactly what a busy PR does. Busy PRs are also what contend, so the two peak together. It happened in
// the same window the installation exhausted its REST quota.
//
// Asserted structurally, on source order, because there is no behavioural seam here: both orderings produce
// identical results on the happy path and differ only in what a LOSING pass spends before it throws. A unit
// test that exercised the pass could not tell them apart, which is precisely why this drifted unnoticed.

const SOURCE = readFileSync(join(import.meta.dirname, "..", "..", "src", "queue", "processors.ts"), "utf8");

describe("actuation lock ordering (#10174)", () => {
  it("sanity: both landmarks still exist, so a rename cannot make this pass vacuously", () => {
    expect(SOURCE).toContain("claimPrActuationLock");
    expect(SOURCE).toContain("refreshPullRequestDetails");
  });

  it("REGRESSION: the publish pass claims the lock before refreshing PR details", () => {
    // Scoped to the publish-and-maintain pass by anchoring on its own contention audit event, so the
    // assertion cannot be satisfied by some unrelated earlier claim elsewhere in this 16k-line file.
    const contention = SOURCE.indexOf('eventType: "github_app.pr_public_surface_lock_contended"');
    expect(contention).toBeGreaterThan(-1);

    const claimBefore = SOURCE.lastIndexOf("claimPrActuationLock", contention);
    expect(claimBefore).toBeGreaterThan(-1);

    // The refresh must come AFTER that claim, not before it.
    const refreshAfterClaim = SOURCE.indexOf("refreshPullRequestDetails(env, repoFullName, prNumber)", claimBefore);
    const refreshBeforeClaim = SOURCE.lastIndexOf("refreshPullRequestDetails(env, repoFullName, prNumber)", claimBefore);

    expect(refreshAfterClaim, "the refresh should follow the lock claim").toBeGreaterThan(claimBefore);
    // And there must be no refresh sitting between the advisory persist and the claim.
    const persist = SOURCE.lastIndexOf("await persistAdvisory(env, advisory)", claimBefore);
    expect(
      refreshBeforeClaim < persist,
      "refreshPullRequestDetails must not run between persistAdvisory and the lock claim — that is the wasted work this fixes",
    ).toBe(true);
  });
});
