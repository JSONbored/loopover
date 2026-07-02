import { describe, expect, it } from "vitest";
import {
  ARTIFACT_PATTERN,
  FLAT_PROVIDER_PATTERN,
  METAGRAPHED_LANE_SPEC,
  SUBNET_ENTRY_PATTERN,
  assessProviderDocument,
  assessSubnetDocument,
  type RegistryLaneSpec,
} from "../../src/review/content-lane/registry-logic";
import { diffAppendedSurfaceEntries, runSurfaceReview, type SurfaceReviewInput } from "../../src/review/content-lane/orchestrator";

const existing = { kind: "website", url: "https://old.example.ai", source_url: "https://github.com/a/b", public_safe: true };
const newEntry = { kind: "subnet-api", url: "https://api.example.ai", source_url: "https://github.com/x/y", public_safe: true };
const newEntry2 = { kind: "openapi", url: "https://api2.example.ai", source_url: "https://github.com/x/z", public_safe: true };
const SUBNET = "registry/subnets/foo.json";
const PROVIDER = "registry/providers/acme.json";
// A spec-less-backward-compat stand-in: the default single-entry cap (no maxAppendedEntries override), otherwise
// identical to metagraphed's file layout (incl. reusing its real validators — this fixture tests the STRUCTURAL
// layer at a different cap, not a different domain) so SUBNET still classifies as an entry-submission.
const STRICT_SPEC: RegistryLaneSpec = {
  entryFilePattern: SUBNET_ENTRY_PATTERN,
  providerFilePattern: FLAT_PROVIDER_PATTERN,
  artifactPattern: ARTIFACT_PATTERN,
  collectionField: "surfaces",
  assessAppendedEntry: assessSubnetDocument,
  assessProviderEntry: assessProviderDocument,
};

// Inject a file loader keyed by `${ref}:${path}` so the orchestrator never hits the network.
function loader(files: Record<string, string | null>): SurfaceReviewInput["loadFile"] {
  return (path, ref) => Promise.resolve(files[`${ref}:${path}`] ?? null);
}
const review = (changedFiles: string[], files: Record<string, string | null>, spec: RegistryLaneSpec = METAGRAPHED_LANE_SPEC) =>
  runSurfaceReview(spec, { changedFiles, loadFile: loader(files) });

describe("diffAppendedSurfaceEntries", () => {
  const doc = (surfaces: unknown[]) => JSON.stringify({ netuid: 14, surfaces });

  it("returns every entry added at head", () => {
    expect(diffAppendedSurfaceEntries(doc([existing, newEntry]), doc([existing]), "surfaces")).toEqual([newEntry]);
    expect(diffAppendedSurfaceEntries(doc([existing, newEntry, newEntry2]), doc([existing]), "surfaces")).toEqual([newEntry, newEntry2]);
  });

  it("treats every entry as new when the base file is absent", () => {
    expect(diffAppendedSurfaceEntries(doc([newEntry]), null, "surfaces")).toEqual([newEntry]);
    expect(diffAppendedSurfaceEntries(doc([existing, newEntry]), null, "surfaces")).toEqual([existing, newEntry]);
  });

  it("returns an empty array when nothing was added", () => {
    expect(diffAppendedSurfaceEntries(doc([existing]), doc([existing]), "surfaces")).toEqual([]);
  });

  it("returns null when head is unparseable or has no surfaces[] array", () => {
    expect(diffAppendedSurfaceEntries("{not json", doc([existing]), "surfaces")).toBeNull();
    expect(diffAppendedSurfaceEntries(JSON.stringify({ netuid: 14 }), doc([existing]), "surfaces")).toBeNull();
  });
});

describe("runSurfaceReview (deterministic + decisive: merge/close, rarely manual)", () => {
  const doc = (surfaces: unknown[]) => JSON.stringify({ netuid: 14, surfaces });

  it("returns null for a non-submission PR (the surface lane defers to the generic gate)", async () => {
    expect(await review(["README.md"], {})).toBeNull();
  });

  it("closes a submission bundled with other file changes (mixed-files)", async () => {
    expect((await review([SUBNET, "src/index.ts"], {}))?.verdict).toBe("close");
  });

  it("closes a multi-entry registry submission instead of deferring to the generic gate", async () => {
    const calls: string[] = [];
    const result = await runSurfaceReview(METAGRAPHED_LANE_SPEC, {
      changedFiles: [SUBNET, "registry/subnets/bar.json"],
      loadFile: (path, ref) => {
        calls.push(`${ref}:${path}`);
        return Promise.resolve(null);
      },
    });

    expect(result?.verdict).toBe("close");
    expect(calls).toEqual([]);
  });

  it("merges a valid provider submission and CLOSES an invalid one (never manual)", async () => {
    const okProvider = { [`head:${PROVIDER}`]: JSON.stringify({ provider: { id: "acme", name: "Acme", website_url: "https://acme.example" } }) };
    expect((await review([PROVIDER], okProvider))?.verdict).toBe("merge");
    const badProvider = { [`head:${PROVIDER}`]: JSON.stringify({ provider: { name: "Acme", website_url: "https://acme.example" } }) };
    expect((await review([PROVIDER], badProvider))?.verdict).toBe("close");
  });

  it("merges a clean single append of a valid entry", async () => {
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("merge");
  });

  it("routes companion provider or artifact changes to manual review without trusting the entry verdict", async () => {
    const calls: string[] = [];
    const r = await runSurfaceReview(METAGRAPHED_LANE_SPEC, {
      changedFiles: [SUBNET, PROVIDER],
      loadFile: (path, ref) => {
        calls.push(`${ref}:${path}`);
        return Promise.resolve(ref === "head" ? doc([existing, newEntry]) : doc([existing]));
      },
    });

    expect(r).toEqual({
      verdict: "manual",
      summary: "Registry submission includes companion file changes — routing to review.",
    });
    expect(calls).toEqual([]);
  });

  it("ignores blank changed-file entries while enforcing the direct-file-only invariant", async () => {
    const r = await review(["", SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("merge");
  });

  it("closes a clean single append whose entry has a clear violation", async () => {
    const bad = { ...newEntry, public_safe: false };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, bad]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
  });

  it("closes a zero-entry append (an edit-only PR that appends nothing new)", async () => {
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r).toEqual({
      verdict: "close",
      summary: "A surface submission must append at least one new surfaces[] entry — resubmit a clean append.",
    });
  });

  it("closes when head is unreadable/malformed (diffAppendedSurfaceEntries returns null)", async () => {
    const r = await review([SUBNET], { [`head:${SUBNET}`]: "{not json", [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
  });

  // metagraphed's documented 2026-06 anti-farming policy: several surfaces[] entries for ONE subnet in ONE PR is
  // one merge (PR #2619's exact shape — one registry/subnets/<slug>.json file, two clean new surfaces entries).
  it("merges a clean multi-entry append against the metagraphed spec (PR #2619 shape)", async () => {
    const r = await review([SUBNET], {
      [`head:${SUBNET}`]: doc([existing, newEntry, newEntry2]),
      [`base:${SUBNET}`]: doc([existing]),
    });
    expect(r?.verdict).toBe("merge");
  });

  // Regression for PR #2619 itself (JSONbored/metagraphed): a brand-new registry/subnets/affine.json (GitHub
  // status "added", so base is absent) appending two clean surfaces[] entries in one file. Orb one-shot-closed
  // this with "A surface submission must append exactly one new surfaces[] entry" under the old single-entry cap
  // — it must now MERGE.
  it("merges the real PR #2619 shape: a brand-new subnet file with two clean appended entries", async () => {
    const AFFINE_SUBNET = "registry/subnets/affine.json";
    const affineDoc = {
      categories: [],
      curation: { level: "community-seeded", review_state: "unreviewed" },
      name: "Affine",
      netuid: 120,
      schema_version: 1,
      slug: "sn-120",
      status: "active",
      surfaces: [
        {
          auth_required: false,
          authority: "community",
          id: "sn-120-affine-openapi",
          kind: "openapi",
          name: "Affine API OpenAPI schema",
          notes: "Machine-readable OpenAPI schema for the public Affine validator API.",
          provider: "affine",
          public_safe: true,
          review: { state: "community-submitted", submitted_by: "dragunovx16" },
          schema_status: "machine-readable",
          schema_url: "https://api.affine.io/openapi.json",
          source_urls: [
            "https://raw.githubusercontent.com/AffineFoundation/affine-cortex/main/affine/api/server.py",
            "https://raw.githubusercontent.com/AffineFoundation/affine-cortex/main/affine/utils/api_client.py",
          ],
          url: "https://api.affine.io/openapi.json",
        },
        {
          auth_required: false,
          authority: "community",
          id: "sn-120-affine-subnet-api",
          kind: "subnet-api",
          name: "Affine API health",
          notes: "Safe read-only health endpoint for the public Affine validator API.",
          provider: "affine",
          public_safe: true,
          review: { state: "community-submitted", submitted_by: "dragunovx16" },
          schema_url: "https://api.affine.io/openapi.json",
          source_urls: [
            "https://raw.githubusercontent.com/AffineFoundation/affine-cortex/main/affine/utils/api_client.py",
            "https://raw.githubusercontent.com/AffineFoundation/affine-cortex/main/affine/api/server.py",
          ],
          url: "https://api.affine.io/api/v1/health",
        },
      ],
    };
    const r = await review(
      [AFFINE_SUBNET],
      { [`head:${AFFINE_SUBNET}`]: JSON.stringify(affineDoc) }, // base absent: GitHub reports this file as "added"
    );
    expect(r?.verdict).toBe("merge");
  });

  it("CLOSES a multi-entry append against the metagraphed spec when ANY appended entry is invalid", async () => {
    const bad = { ...newEntry2, public_safe: false };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry, bad]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
    expect(r?.summary).toContain("Surface entry 2 of 2");
  });

  it("routes a multi-entry append to MANUAL when one entry needs manual review and none are invalid", async () => {
    const authEntry = { ...newEntry2, auth_required: true };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry, authEntry]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("manual");
    expect(r?.summary).toContain("Surface entry 2 of 2");
  });

  it("a close among several appended entries wins over an earlier manual one (manual precedes close in array order)", async () => {
    const authEntry = { ...newEntry, auth_required: true };
    const bad = { ...newEntry2, public_safe: false };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, authEntry, bad]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
  });

  it("a close among several appended entries wins over a later manual one too (close precedes manual in array order)", async () => {
    const bad = { ...newEntry, public_safe: false };
    const authEntry = { ...newEntry2, auth_required: true };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, bad, authEntry]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
  });

  it("CLOSES a non-clean append (multiple new entries) when the spec caps at the default of one — resubmit clean, not a manual punt", async () => {
    const r = await review(
      [SUBNET],
      { [`head:${SUBNET}`]: doc([existing, newEntry, newEntry2]), [`base:${SUBNET}`]: doc([existing]) },
      STRICT_SPEC,
    );
    expect(r).toEqual({
      verdict: "close",
      summary: "A surface submission must append exactly one new surfaces[] entry — resubmit a clean single-entry append.",
    });
  });

  it("still merges a clean SINGLE append against the default (spec-less) single-entry cap", async () => {
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry]), [`base:${SUBNET}`]: doc([existing]) }, STRICT_SPEC);
    expect(r?.verdict).toBe("merge");
  });

  it("closes a multi-entry append that exceeds an explicit finite cap with the 'between 1 and N' message", async () => {
    const cappedSpec: RegistryLaneSpec = { ...STRICT_SPEC, maxAppendedEntries: 2 };
    const r = await review(
      [SUBNET],
      { [`head:${SUBNET}`]: doc([existing, newEntry, newEntry2, { ...newEntry, url: "https://api3.example.ai" }]), [`base:${SUBNET}`]: doc([existing]) },
      cappedSpec,
    );
    expect(r).toEqual({
      verdict: "close",
      summary: "A surface submission must append between 1 and 2 new surfaces[] entries in one PR — resubmit a clean append within that range.",
    });
  });

  it("merges a clean append landing EXACTLY on an explicit finite cap (the boundary is inclusive, not exclusive)", async () => {
    const cappedSpec: RegistryLaneSpec = { ...STRICT_SPEC, maxAppendedEntries: 2 };
    const r = await review(
      [SUBNET],
      { [`head:${SUBNET}`]: doc([existing, newEntry, newEntry2]), [`base:${SUBNET}`]: doc([existing]) },
      cappedSpec,
    );
    expect(r?.verdict).toBe("merge");
  });

  // METAGRAPHED_LANE_SPEC opts into duplicateKeyFields: ["url"] specifically because removing the single-entry
  // cap also removed its incidental side effect of rejecting a same-PR duplicate append.
  it("closes a same-PR duplicate append against the metagraphed spec (removing the entry cap removed this incidental protection)", async () => {
    const copy = { ...newEntry, id: "a-copy-of-newEntry" };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry, copy]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
    expect(r?.summary).toContain(newEntry.url);
  });

  it("closes an appended entry that resubmits a url already present in the base document's surfaces[]", async () => {
    const resubmission = { ...existing, id: "resubmitted-existing-url" };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, resubmission]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
    expect(r?.summary).toContain(existing.url);
  });

  it("a same-PR duplicate is still detected across trivial URL formatting differences (trailing slash/tracking params)", async () => {
    const messyDuplicate = { ...newEntry, url: `${newEntry.url}/?utm_source=test` };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry, messyDuplicate]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
  });

  it("a spec without duplicateKeyFields never flags a duplicate (opt-in default preserved for spec-less/backward-compat consumers)", async () => {
    // STRICT_SPEC has no duplicateKeyFields; a SINGLE append (within its cap of 1) that resubmits an existing url
    // must merge, not close, since duplicate detection was never opted into for this spec.
    const resubmission = { ...existing, id: "resubmitted-existing-url" };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, resubmission]), [`base:${SUBNET}`]: doc([existing]) }, STRICT_SPEC);
    expect(r?.verdict).toBe("merge");
  });

  it("the duplicate close summary omits the url detail when the colliding entries have no usable url (a non-'url' duplicateKeyFields spec)", async () => {
    const kindOnlySpec: RegistryLaneSpec = { ...STRICT_SPEC, maxAppendedEntries: Infinity, duplicateKeyFields: ["kind"] };
    const first = { kind: "openapi", public_safe: true };
    const dup = { kind: "openapi", public_safe: true, name: "a differently-named duplicate" };
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, first, dup]), [`base:${SUBNET}`]: doc([existing]) }, kindOnlySpec);
    expect(r).toEqual({
      verdict: "close",
      summary: "A surface submission must not duplicate an entry already in this PR or already in the registry — resubmit without the duplicate.",
    });
  });

  // A spec with no domain-specific validator configured yet: structural gating (scope/count/dedup) still applies,
  // but the orchestrator can't itself judge entry content — routes to manual instead of merging or closing blind.
  const UNVALIDATED_SPEC: RegistryLaneSpec = {
    entryFilePattern: SUBNET_ENTRY_PATTERN,
    providerFilePattern: FLAT_PROVIDER_PATTERN,
    collectionField: "surfaces",
  };

  it("routes a clean single-entry append to MANUAL when the spec has no assessAppendedEntry configured", async () => {
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry]), [`base:${SUBNET}`]: doc([existing]) }, UNVALIDATED_SPEC);
    expect(r).toEqual({
      verdict: "manual",
      summary: "No validator is configured for this registry's surface entries — routing to review.",
    });
  });

  it("routes a provider submission to MANUAL when the spec has no assessProviderEntry configured", async () => {
    const r = await review([PROVIDER], { [`head:${PROVIDER}`]: JSON.stringify({ provider: { id: "acme", name: "Acme", website_url: "https://acme.example" } }) }, UNVALIDATED_SPEC);
    expect(r).toEqual({
      verdict: "manual",
      summary: "No validator is configured for this registry's provider submissions — routing to review.",
    });
  });
});
