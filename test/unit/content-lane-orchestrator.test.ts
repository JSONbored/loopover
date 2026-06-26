import { describe, expect, it } from "vitest";
import { METAGRAPHED_LANE_SPEC } from "../../src/review/content-lane/registry-logic";
import { diffAppendedSurfaceEntry, runSurfaceReview, type SurfaceReviewInput } from "../../src/review/content-lane/orchestrator";

const existing = { kind: "website", url: "https://old.example.ai", source_url: "https://github.com/a/b", public_safe: true };
const newEntry = { kind: "subnet-api", url: "https://api.example.ai", source_url: "https://github.com/x/y", public_safe: true };
const SUBNET = "registry/subnets/foo.json";
const PROVIDER = "registry/providers/acme.json";

// Inject a file loader keyed by `${ref}:${path}` so the orchestrator never hits the network.
function loader(files: Record<string, string | null>): SurfaceReviewInput["loadFile"] {
  return (path, ref) => Promise.resolve(files[`${ref}:${path}`] ?? null);
}
const review = (changedFiles: string[], files: Record<string, string | null>) =>
  runSurfaceReview(METAGRAPHED_LANE_SPEC, { changedFiles, loadFile: loader(files) });

describe("diffAppendedSurfaceEntry", () => {
  const doc = (surfaces: unknown[]) => JSON.stringify({ netuid: 14, surfaces });

  it("returns the single entry added at head", () => {
    expect(diffAppendedSurfaceEntry(doc([existing, newEntry]), doc([existing]), "surfaces")).toEqual(newEntry);
  });

  it("treats every entry as new when the base file is absent (passes only with exactly one)", () => {
    expect(diffAppendedSurfaceEntry(doc([newEntry]), null, "surfaces")).toEqual(newEntry);
    expect(diffAppendedSurfaceEntry(doc([existing, newEntry]), null, "surfaces")).toBeNull();
  });

  it("returns null for zero or multiple added entries", () => {
    expect(diffAppendedSurfaceEntry(doc([existing]), doc([existing]), "surfaces")).toBeNull();
    expect(diffAppendedSurfaceEntry(doc([existing, newEntry, { kind: "other" }]), doc([existing]), "surfaces")).toBeNull();
  });

  it("returns null when head is unparseable or has no surfaces[] array", () => {
    expect(diffAppendedSurfaceEntry("{not json", doc([existing]), "surfaces")).toBeNull();
    expect(diffAppendedSurfaceEntry(JSON.stringify({ netuid: 14 }), doc([existing]), "surfaces")).toBeNull();
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

  it("CLOSES a non-clean append (multiple new entries) — resubmit clean, not a manual punt", async () => {
    const r = await review([SUBNET], { [`head:${SUBNET}`]: doc([existing, newEntry, { kind: "extra" }]), [`base:${SUBNET}`]: doc([existing]) });
    expect(r?.verdict).toBe("close");
  });
});
