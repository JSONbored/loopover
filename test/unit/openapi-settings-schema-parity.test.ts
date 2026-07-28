import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { defaultRepositorySettings } from "../../src/db/repositories";
import { RepoSettingsPreviewSchema, RepositorySettingsSchema } from "../../src/openapi/schemas";
import type { RepoSettingsPreview } from "../../src/signals/settings-preview";
import type { RepositorySettings } from "../../src/types";

// #9531: RepositorySettingsSchema/RepoSettingsPreviewSchema (src/openapi/schemas.ts) are hand-authored Zod
// schemas, and ui:openapi:check only verifies the generated openapi.json matches THEM -- never that they
// match the TS types the handlers actually serialize. scripts/check-openapi-settings-parity.ts (#2556/#7011)
// closed that gap by regex-diffing the two KEY SETS out of the raw source text; the assertions below replace
// it and subsume it, because the compiler compares what a key-set diff structurally cannot: each field's
// optionality, nullability, and value type, in BOTH directions. Retiring the script also retires its own
// blind spots -- it could only ever see top-level names, and it re-parsed src/types.ts by brace-and-indent
// heuristics that any reformatting would have quietly broken.
//
// Three published-spec defects it had been unable to see, all found the moment these assertions compiled:
// the dead `autonomy` levels (#4620), `contributorBlacklist.githubId` (#9125), and `moderationRules`'
// missing `copycat` member -- see each field's own comment in src/openapi/schemas.ts.

/** Exact type equality (not mutual assignability): the deferred-conditional identity trick, which compares
 *  the two types structurally rather than checking each is assignable to the other -- the latter treats
 *  `{ a?: T }` and `{ a: T | undefined }` as interchangeable in one direction, which is exactly the drift
 *  class an OpenAPI schema is most likely to have. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The keys on which two object types disagree. Each key is compared through `Pick` so its OPTIONALITY is
 *  part of the comparison, and a key present in only one of the two types compares `{}` against `{ k: V }`
 *  -- so a missing field and a mistyped field are both caught, by the same mechanism.
 *
 *  This exists instead of a bare `Equal<A, B>` assertion so a failure NAMES the drifted field the way the
 *  retired script's error message did: {@link AssertNoSchemaDrift} constrains its parameter to `never`, so
 *  tsc reports the offending key as the type that "does not satisfy the constraint". */
type DriftedKeys<A, B> = {
  [K in keyof A | keyof B]-?: Equal<Pick<A, K & keyof A>, Pick<B, K & keyof B>> extends true ? never : K;
}[keyof A | keyof B];

/** A drifted field turns each instantiation below into a `tsc` error naming that field. Fix
 *  src/openapi/schemas.ts (or the type, when the route genuinely omits the field), then `npm run ui:openapi`. */
type AssertNoSchemaDrift<_Drifted extends never> = true;

/** GET /v1/repos/:owner/:repo/settings serializes a RepositorySettings verbatim. */
type RepositorySettingsParity = AssertNoSchemaDrift<DriftedKeys<z.infer<typeof RepositorySettingsSchema>, RepositorySettings>>;
/** GET /v1/repos/:owner/:repo/settings-preview serializes buildRepoSettingsPreview's RepoSettingsPreview. */
type RepoSettingsPreviewParity = AssertNoSchemaDrift<DriftedKeys<z.infer<typeof RepoSettingsPreviewSchema>, RepoSettingsPreview>>;

// The two aliases are checked when tsc INSTANTIATES them, which only happens where they are referenced --
// hence this anchor, rather than two dangling type declarations a later cleanup would read as dead.
const schemaParity: [RepositorySettingsParity, RepoSettingsPreviewParity] = [true, true];

describe("RepositorySettingsSchema parity with the RepositorySettings type (#9531)", () => {
  it("compiles the schema-vs-type drift assertions", () => {
    expect(schemaParity).toEqual([true, true]);
  });

  // The assertions above are erased at runtime, so this pins the other half of the contract: that the schema
  // ACCEPTS a real payload. A field the schema requires but no read path actually populates would compile
  // fine (the type says required) and still reject every generated client -- only parsing catches that.
  it("accepts the built-in defaults every no-row settings read returns", () => {
    const parsed = RepositorySettingsSchema.safeParse(defaultRepositorySettings("JSONbored/loopover"));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("rejects a payload missing a config-as-code field both read paths always populate", () => {
    const { screenshotTableGate: _omitted, ...withoutScreenshotTableGate } = defaultRepositorySettings("JSONbored/loopover");
    expect(RepositorySettingsSchema.safeParse(withoutScreenshotTableGate).success).toBe(false);
  });

  // #9125's immutable-id field: returned by the API since it landed, absent from the published schema until
  // the parity assertion above flagged it.
  it("accepts a contributor-blacklist entry carrying the immutable githubId (#9125)", () => {
    const parsed = RepositorySettingsSchema.safeParse({
      ...defaultRepositorySettings("JSONbored/loopover"),
      contributorBlacklist: [{ login: "banned-user", githubId: 4242, reason: "slop", evidence: ["https://github.com/JSONbored/loopover/pull/1"], addedAt: "2026-07-28T00:00:00.000Z" }],
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  // #4620 removed "suggest"/"propose" from AutonomyLevel -- both were behaviorally identical to "observe"
  // from day one -- but the published schema kept advertising them for every action class.
  it("accepts every live autonomy level and rejects the two #4620 removed", () => {
    const settings = defaultRepositorySettings("JSONbored/loopover");
    expect(RepositorySettingsSchema.safeParse({ ...settings, autonomy: { review: "observe", merge: "auto_with_approval", close: "auto" } }).success).toBe(true);
    expect(RepositorySettingsSchema.safeParse({ ...settings, autonomy: { review: "suggest" } }).success).toBe(false);
    expect(RepositorySettingsSchema.safeParse({ ...settings, autonomy: { review: "propose" } }).success).toBe(false);
  });

  // #1969 folded copycat containment into the same generic moderation-violation ledger as the other four
  // rules, making "copycat" a real ModerationRuleType this route can return.
  it("accepts every moderation rule the type declares, copycat included (#1969)", () => {
    const settings = defaultRepositorySettings("JSONbored/loopover");
    const moderationRules: RepositorySettings["moderationRules"] = ["contributor_cap", "blacklist", "review_nag", "review_evasion", "copycat"];
    expect(RepositorySettingsSchema.safeParse({ ...settings, moderationRules }).success).toBe(true);
  });

  it("rejects contributor open caps above the enforcement sample budget", () => {
    expect(() => RepositorySettingsSchema.partial().parse({ contributorOpenPrCap: 101 })).toThrow();
    expect(() => RepositorySettingsSchema.partial().parse({ contributorOpenIssueCap: 101 })).toThrow();
    expect(RepositorySettingsSchema.partial().parse({ contributorOpenPrCap: 100, contributorOpenIssueCap: 100 })).toMatchObject({ contributorOpenPrCap: 100, contributorOpenIssueCap: 100 });
  });
});

describe("defaultRepositorySettings (#9531)", () => {
  it("carries the caller's repo name and the built-in config-as-code defaults", () => {
    const settings = defaultRepositorySettings("acme/widgets");
    expect(settings.repoFullName).toBe("acme/widgets");
    expect(settings.blacklistLabel).toBe("slop");
    expect(settings.autonomy).toEqual({});
    expect(settings.contributorBlacklist).toEqual([]);
    expect(settings.synchronizeClosePolicy).toBe("off");
    expect(settings.linkedIssueHardRules.pointBearingLabels).toEqual([]);
    expect(settings.screenshotTableGate.whenLabels).toEqual([]);
  });

  it("returns an independent object per call, so a mutated default never leaks into the next read", () => {
    const first = defaultRepositorySettings("acme/widgets");
    first.linkedIssueHardRules.pointBearingLabels.push("points:3");
    expect(defaultRepositorySettings("acme/widgets").linkedIssueHardRules.pointBearingLabels).toEqual([]);
  });
});
