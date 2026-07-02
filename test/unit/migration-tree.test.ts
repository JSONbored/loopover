import { afterEach, describe, expect, it, vi } from "vitest";
import { listMigrationFilenamesAtRef } from "../../src/github/migration-tree";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listMigrationFilenamesAtRef (#2550)", () => {
  it("returns the .sql filenames directly under migrations/, filtering out non-matching entries", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(input.toString()).toContain("/git/trees/main?recursive=1");
      return Response.json({
        tree: [
          { type: "blob", path: "migrations/0001_initial.sql" },
          { type: "blob", path: "migrations/0002_second.sql" },
          { type: "blob", path: "src/index.ts" }, // outside migrations/ — excluded
          { type: "tree", path: "migrations" }, // a directory node itself — excluded (not a blob)
          { type: "blob", path: "migrations/nested/0003_nested.sql" }, // nested — excluded (migrations/ is flat)
          { type: "blob", path: "migrations/README.md" }, // non-.sql — excluded
        ],
      });
    });

    const result = await listMigrationFilenamesAtRef("owner/repo", "main", "token", undefined);
    expect(result).toEqual(["0001_initial.sql", "0002_second.sql"]);
  });

  it("returns [] when the tree is empty or the tree field is absent", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    expect(await listMigrationFilenamesAtRef("owner/repo", "main", "token", undefined)).toEqual([]);
  });

  it("returns null (fail-safe) on a non-OK response", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    expect(await listMigrationFilenamesAtRef("owner/repo", "main", "token", undefined)).toBeNull();
  });

  it("returns null (fail-safe) when the tree response is truncated — an incomplete list is inconclusive, not evidence of no collision", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ truncated: true, tree: [{ type: "blob", path: "migrations/0001_initial.sql" }] }));
    expect(await listMigrationFilenamesAtRef("owner/repo", "main", "token", undefined)).toBeNull();
  });

  it("returns the full list when truncated is explicitly false or absent", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ truncated: false, tree: [{ type: "blob", path: "migrations/0001_initial.sql" }] }));
    expect(await listMigrationFilenamesAtRef("owner/repo", "main", "token", undefined)).toEqual(["0001_initial.sql"]);
  });

  it("returns null (fail-safe) when the fetch throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await listMigrationFilenamesAtRef("owner/repo", "main", "token", undefined)).toBeNull();
  });

  it("works without a token (unauthenticated/public read)", async () => {
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.authorization).toBeUndefined();
      return Response.json({ tree: [{ type: "blob", path: "migrations/0001_initial.sql" }] });
    });
    expect(await listMigrationFilenamesAtRef("owner/repo", "main", undefined, undefined)).toEqual(["0001_initial.sql"]);
  });
});
