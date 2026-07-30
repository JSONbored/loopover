// The Worker-side bounds that @loopover/contract restates must equal their originals (#9773 follow-up).
//
// WHY THIS EXISTS. limits.ts says these entries are "pinned against their originals like every other entry
// here" -- but PREFLIGHT_LIMITS was the only group with a meta-test actually doing the pinning. The three
// single constants were restated on trust, which is the same thing as not being pinned.
//
// The failure this catches is quiet and one-sided: the contract package cannot import the Worker's `src/`
// (it is a zod-only leaf, which is the property every other surface depends on), so nothing at compile time
// relates the two copies. Raise a bound on the Worker side alone and the published schema keeps rejecting
// input the server would now accept; lower it alone and the schema accepts input the server then rejects or
// truncates. Either way the mismatch surfaces as a confusing client-side validation error rather than as a
// build failure.
//
// This is not a hypothetical. gen-contract-api-schemas.ts copies these schemas verbatim, so a copied schema
// referencing a constant that has NOT been restated here emits a file that does not compile -- the
// generator's own doc calls that "the loud failure this wants". #9738 added
// `.max(MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES)` to the settings schema without adding the constant, which
// left `main` failing `contract:api-schemas:check` for every PR: regenerating produced an uncompilable file,
// and not regenerating left the check red. The constant is now restated; this test is what keeps the VALUES
// together from here on, which the compile-time failure alone never did.
import { describe, expect, it } from "vitest";

import {
  MAX_CONTRIBUTOR_OPEN_ITEM_CAP as CONTRACT_MAX_CONTRIBUTOR_OPEN_ITEM_CAP,
  MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES as CONTRACT_MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES,
  MAX_REVIEW_NAG_COOLDOWN_DAYS as CONTRACT_MAX_REVIEW_NAG_COOLDOWN_DAYS,
} from "../../packages/loopover-contract/src/limits";
import { MAX_REVIEW_NAG_COOLDOWN_DAYS } from "../../src/settings/agent-actions";
import { MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES } from "../../src/review/priority-eligibility-window";
import { MAX_CONTRIBUTOR_OPEN_ITEM_CAP } from "../../src/types";

describe("@loopover/contract restated Worker bounds stay pinned to their originals", () => {
  // One case per constant rather than a table, so a failure names the specific bound that drifted and the
  // file it has to be reconciled with.
  it("MAX_CONTRIBUTOR_OPEN_ITEM_CAP matches src/types.ts", () => {
    expect(CONTRACT_MAX_CONTRIBUTOR_OPEN_ITEM_CAP).toBe(MAX_CONTRIBUTOR_OPEN_ITEM_CAP);
  });

  it("MAX_REVIEW_NAG_COOLDOWN_DAYS matches src/settings/agent-actions.ts", () => {
    expect(CONTRACT_MAX_REVIEW_NAG_COOLDOWN_DAYS).toBe(MAX_REVIEW_NAG_COOLDOWN_DAYS);
  });

  it("MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES matches src/review/priority-eligibility-window.ts", () => {
    expect(CONTRACT_MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES).toBe(MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES);
  });
});
