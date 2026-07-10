import { describe, expect, it } from "vitest";

import { handleRunStateRequest, type RunStateApiDeps } from "../vite-run-state-api";

const rows = [{ repoFullName: "acme/widgets", state: "idle", updatedAt: "2026-07-10T06:00:00.000Z" }];

function deps(overrides: Partial<RunStateApiDeps> = {}): RunStateApiDeps {
  return {
    loadRunStateModule: async () => ({
      resolveRunStateDbPath: () => "/home/miner/.config/gittensory-miner/run-state.sqlite3",
      listRunStates: () => rows,
    }),
    fileExists: () => true,
    ...overrides,
  };
}

describe("handleRunStateRequest (#4305)", () => {
  it("serves the run-state rows via the existing run-state.js exports", async () => {
    const handled = await handleRunStateRequest("GET", "/api/run-state", deps());
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ rows }) });
  });

  it("serves [] on a fresh install WITHOUT initializing the store (no DB file => no listRunStates call)", async () => {
    let listed = false;
    const handled = await handleRunStateRequest(
      "GET",
      "/api/run-state",
      deps({
        loadRunStateModule: async () => ({
          resolveRunStateDbPath: () => "/nowhere/run-state.sqlite3",
          listRunStates: () => {
            listed = true;
            return rows;
          },
        }),
        fileExists: () => false,
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ rows: [] }) });
    expect(listed).toBe(false);
  });

  it("falls through (null) for other paths and non-GET methods", async () => {
    expect(await handleRunStateRequest("GET", "/api/other", deps())).toBeNull();
    expect(await handleRunStateRequest("POST", "/api/run-state", deps())).toBeNull();
  });

  it("surfaces a store read failure as a 500 with a safe message", async () => {
    const handled = await handleRunStateRequest(
      "GET",
      "/api/run-state",
      deps({
        loadRunStateModule: async () => {
          throw new Error("sqlite locked");
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });
});
