import { describe, expect, it, vi } from "vitest";

// #10170: the repo-set assembly was duplicated five times (three inside processors.ts) and, being inline in
// each caller, was never tested on its own -- only incidentally, through whichever sweep happened to cover it.
// Its merge semantics are load-bearing: get them wrong and a fleet-wide pass silently skips repos, or treats
// an uninstalled one as installed.

vi.mock("../../src/db/repositories", () => ({ listRepositories: vi.fn() }));
vi.mock("../../src/review/cutover-gate", () => ({ listConvergenceRepos: vi.fn() }));

const { listRepositories } = await import("../../src/db/repositories");
const { listConvergenceRepos } = await import("../../src/review/cutover-gate");
const { resolveConfiguredRepoCandidates } = await import("../../src/review/configured-repo-set");

const env = {} as Env;
const setup = (rows: unknown[], convergence: string[]) => {
  vi.mocked(listRepositories).mockResolvedValue(rows as never);
  vi.mocked(listConvergenceRepos).mockReturnValue(convergence as never);
};

describe("resolveConfiguredRepoCandidates (#10170)", () => {
  it("returns locally-known repos, carrying installationId", async () => {
    setup([{ fullName: "acme/widgets", installationId: 42 }], []);
    expect(await resolveConfiguredRepoCandidates(env)).toEqual([{ fullName: "acme/widgets", installationId: 42 }]);
  });

  it("includes a convergence repo that has no local row", async () => {
    // The whole reason the two sources are merged: an allowlisted repo is in scope before it is ever synced.
    setup([], ["acme/newrepo"]);
    expect(await resolveConfiguredRepoCandidates(env)).toEqual([{ fullName: "acme/newrepo" }]);
  });

  it("OMITS installationId rather than setting it null when unknown", async () => {
    // Every call site spreads this under exactOptionalPropertyTypes, and callers gate on
    // `typeof repo.installationId === "number"`. A null would satisfy neither.
    setup([], ["acme/newrepo"]);
    const [repo] = await resolveConfiguredRepoCandidates(env);
    expect("installationId" in (repo ?? {})).toBe(false);
  });

  it("REGRESSION: a convergence entry carries over the local row's installationId", async () => {
    // The convergence list holds only names. Losing the installationId here would make a genuinely installed
    // repo look uninstalled, and every caller that requires a real installation would skip it -- a
    // fleet-wide sweep quietly doing nothing.
    setup([{ fullName: "acme/widgets", installationId: 7 }], ["acme/widgets"]);
    expect(await resolveConfiguredRepoCandidates(env)).toEqual([{ fullName: "acme/widgets", installationId: 7 }]);
  });

  it("de-duplicates case-insensitively, and the convergence spelling wins", async () => {
    // GitHub full names are case-insensitive; two entries for one repo would double every per-repo read.
    setup([{ fullName: "Acme/Widgets", installationId: 7 }], ["acme/widgets"]);
    const out = await resolveConfiguredRepoCandidates(env);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ fullName: "acme/widgets", installationId: 7 });
  });

  it("is empty when both sources are", async () => {
    setup([], []);
    expect(await resolveConfiguredRepoCandidates(env)).toEqual([]);
  });
});
