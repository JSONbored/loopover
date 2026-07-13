import { describe, expect, it } from "vitest";
import { buildRegistryLaneSpecFromConfig, registeredValidatorIds, resolveRegistryLaneSpec, unregisteredValidatorId } from "../../src/review/content-lane/spec-resolver";
import { METAGRAPHED_LANE_SPEC } from "../../src/review/content-lane/registry-logic";
import { parseFocusManifest, type FocusManifestContentLaneConfig } from "../../src/signals/focus-manifest";

const EMPTY_CONFIG: FocusManifestContentLaneConfig = {
  present: false,
  entryFileGlob: null,
  providerFileGlob: null,
  artifactGlob: null,
  collectionField: null,
  maxAppendedEntries: null,
  duplicateKeyFields: [],
  validatorId: null,
};

describe("buildRegistryLaneSpecFromConfig", () => {
  it("returns null when the config is not present", () => {
    expect(buildRegistryLaneSpecFromConfig(EMPTY_CONFIG)).toBeNull();
  });

  it("returns null when required fields are missing despite present:true (defensive — parseContentLaneConfig never produces this, but the builder doesn't trust that alone)", () => {
    expect(buildRegistryLaneSpecFromConfig({ ...EMPTY_CONFIG, present: true, entryFileGlob: null, collectionField: "items" })).toBeNull();
    expect(buildRegistryLaneSpecFromConfig({ ...EMPTY_CONFIG, present: true, entryFileGlob: "registry/*.json", collectionField: null })).toBeNull();
  });

  it("builds a minimal spec from just the two required fields", () => {
    const spec = buildRegistryLaneSpecFromConfig({ ...EMPTY_CONFIG, present: true, entryFileGlob: "registry/items/*.json", collectionField: "items" });
    expect(spec).not.toBeNull();
    expect(spec?.entryFilePattern.test("registry/items/foo.json")).toBe(true);
    expect(spec?.entryFilePattern.test("registry/items/foo/bar.json")).toBe(false); // single-segment glob, not **
    expect(spec?.collectionField).toBe("items");
    expect(spec?.providerFilePattern).toBeUndefined();
    expect(spec?.artifactPattern).toBeUndefined();
    expect(spec?.maxAppendedEntries).toBeUndefined();
    expect(spec?.duplicateKeyFields).toBeUndefined();
    expect(spec?.assessAppendedEntry).toBeUndefined();
    expect(spec?.assessProviderEntry).toBeUndefined();
  });

  it("compiles providerFileGlob and artifactGlob via the same bounded glob compiler (not a raw regex)", () => {
    const spec = buildRegistryLaneSpecFromConfig({
      ...EMPTY_CONFIG,
      present: true,
      entryFileGlob: "registry/items/*.json",
      providerFileGlob: "registry/providers/*.json",
      artifactGlob: "public/**/*.json",
      collectionField: "items",
    });
    expect(spec?.providerFilePattern?.test("registry/providers/acme.json")).toBe(true);
    expect(spec?.providerFilePattern?.test("registry/providers/nested/acme.json")).toBe(false);
    expect(spec?.artifactPattern?.test("public/a/b/c.json")).toBe(true); // ** crosses segments
  });

  it("passes maxAppendedEntries and duplicateKeyFields through when set", () => {
    const spec = buildRegistryLaneSpecFromConfig({
      ...EMPTY_CONFIG,
      present: true,
      entryFileGlob: "registry/items/*.json",
      collectionField: "items",
      maxAppendedEntries: 3,
      duplicateKeyFields: ["url"],
    });
    expect(spec?.maxAppendedEntries).toBe(3);
    expect(spec?.duplicateKeyFields).toEqual(["url"]);
  });

  it("resolves a registered validatorId to its code-registered validator pair", () => {
    const spec = buildRegistryLaneSpecFromConfig({
      ...EMPTY_CONFIG,
      present: true,
      entryFileGlob: "registry/subnets/*.json",
      collectionField: "surfaces",
      validatorId: "metagraphed",
    });
    expect(spec?.assessAppendedEntry).toBeDefined();
    expect(spec?.assessProviderEntry).toBeDefined();
  });

  it("degrades to structural-gating-only (no validator) for an UNREGISTERED validatorId — never throws", () => {
    const spec = buildRegistryLaneSpecFromConfig({
      ...EMPTY_CONFIG,
      present: true,
      entryFileGlob: "registry/items/*.json",
      collectionField: "items",
      validatorId: "some-registry-nobody-registered-yet",
    });
    expect(spec).not.toBeNull();
    expect(spec?.assessAppendedEntry).toBeUndefined();
    expect(spec?.assessProviderEntry).toBeUndefined();
  });
});

describe("registeredValidatorIds", () => {
  it("lists the code-registered validator ids (currently just metagraphed)", () => {
    expect(registeredValidatorIds()).toEqual(["metagraphed"]);
  });
});

describe("unregisteredValidatorId (operator-typo diagnostic — separate from buildRegistryLaneSpecFromConfig's silent structural-only degrade)", () => {
  it("is null when no validatorId is configured at all", () => {
    expect(unregisteredValidatorId(EMPTY_CONFIG)).toBeNull();
    expect(unregisteredValidatorId({ ...EMPTY_CONFIG, validatorId: null })).toBeNull();
  });

  it("is null for a registered validatorId", () => {
    expect(unregisteredValidatorId({ ...EMPTY_CONFIG, validatorId: "metagraphed" })).toBeNull();
  });

  it("returns the offending id for an unregistered validatorId", () => {
    expect(unregisteredValidatorId({ ...EMPTY_CONFIG, validatorId: "some-registry-nobody-registered-yet" })).toBe("some-registry-nobody-registered-yet");
  });

  it("degrades to null (not a crash) for a null/undefined config", () => {
    expect(unregisteredValidatorId(null)).toBeNull();
    expect(unregisteredValidatorId(undefined)).toBeNull();
  });

  it("SECURITY: a validatorId matching an inherited Object.prototype key is still reported as unregistered (Object.hasOwn, not `in`/bracket-truthiness)", () => {
    expect(unregisteredValidatorId({ ...EMPTY_CONFIG, validatorId: "toString" })).toBe("toString");
    expect(unregisteredValidatorId({ ...EMPTY_CONFIG, validatorId: "constructor" })).toBe("constructor");
    expect(unregisteredValidatorId({ ...EMPTY_CONFIG, validatorId: "hasOwnProperty" })).toBe("hasOwnProperty");
  });
});

describe("resolveRegistryLaneSpec (precedence: env kill-switch → per-repo config → allowlist default → inactive)", () => {
  const REPO = "SomeoneElse/other-registry";

  it("is null when the env kill-switch is off, even with an explicit config or an allowlist entry", () => {
    const manifest = parseFocusManifest({ contentLane: { entryFileGlob: "registry/*.json", collectionField: "items" } });
    expect(resolveRegistryLaneSpec({ LOOPOVER_REVIEW_REPOS: REPO }, manifest, REPO)).toBeNull();
  });

  it("falls back to the allowlist default (METAGRAPHED_LANE_SPEC) when no per-repo config is present", () => {
    const manifest = parseFocusManifest(null);
    const spec = resolveRegistryLaneSpec({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO }, manifest, REPO);
    expect(spec).toBe(METAGRAPHED_LANE_SPEC);
  });

  it("is null when there's no config AND the repo is not in the allowlist — inactive", () => {
    const manifest = parseFocusManifest(null);
    expect(resolveRegistryLaneSpec({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: "Other/repo" }, manifest, REPO)).toBeNull();
  });

  it("an explicit per-repo config WINS over the allowlist default, even for a repo not in the allowlist at all", () => {
    const manifest = parseFocusManifest({ contentLane: { entryFileGlob: "registry/items/*.json", collectionField: "items" } });
    const spec = resolveRegistryLaneSpec({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: "Other/repo" }, manifest, REPO);
    expect(spec).not.toBeNull();
    expect(spec).not.toBe(METAGRAPHED_LANE_SPEC);
    expect(spec?.collectionField).toBe("items");
  });

  it("a null/undefined manifest degrades to the allowlist-default path, not a crash", () => {
    expect(resolveRegistryLaneSpec({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO }, null, REPO)).toBe(METAGRAPHED_LANE_SPEC);
    expect(resolveRegistryLaneSpec({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: REPO }, undefined, REPO)).toBe(METAGRAPHED_LANE_SPEC);
  });
});
