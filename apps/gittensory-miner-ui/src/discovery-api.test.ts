import { describe, expect, it } from "vitest";

import { handleDiscoveryRequest, type DiscoveryApiDeps } from "../vite-discovery-api";

const candidates = [
  {
    repoFullName: "acme/widgets",
    issueNumber: 12,
    title: "Add cursor pagination",
    labels: ["help wanted"],
    rankScore: 0.82,
  },
  { repoFullName: "acme/widgets", issueNumber: 7, title: "Fix flaky test", labels: [], rankScore: 0.41 },
];

function deps(overrides: Partial<DiscoveryApiDeps> = {}): DiscoveryApiDeps {
  return {
    loadDiscoveredCandidatesModule: async () => ({
      resolveEventLedgerDbPath: () => "/home/miner/.config/gittensory-miner/event-ledger.sqlite3",
      listDiscoveredRankedCandidates: () => candidates,
    }),
    fileExists: () => true,
    ...overrides,
  };
}

describe("handleDiscoveryRequest (#4859)", () => {
  it("serves the ranked candidates via the discovered-candidates reader for loopback clients", async () => {
    const handled = await handleDiscoveryRequest("GET", "/api/discovery", deps(), "127.0.0.1");
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ rankedCandidates: candidates }) });
  });

  it("serves [] on a fresh install WITHOUT initializing the ledger (no DB file => no reader call)", async () => {
    let listed = false;
    const handled = await handleDiscoveryRequest(
      "GET",
      "/api/discovery",
      deps({
        loadDiscoveredCandidatesModule: async () => ({
          resolveEventLedgerDbPath: () => "/nowhere/event-ledger.sqlite3",
          listDiscoveredRankedCandidates: () => {
            listed = true;
            return candidates;
          },
        }),
        fileExists: () => false,
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ rankedCandidates: [] }) });
    expect(listed).toBe(false);
  });

  it("denies non-loopback clients before loading the local store", async () => {
    let loaded = false;
    const handled = await handleDiscoveryRequest(
      "GET",
      "/api/discovery",
      deps({
        loadDiscoveredCandidatesModule: async () => {
          loaded = true;
          throw new Error("must not load");
        },
      }),
      "192.168.1.50",
    );
    expect(handled).toEqual({
      status: 403,
      body: JSON.stringify({ error: "discovery API is only available from loopback clients" }),
    });
    expect(loaded).toBe(false);
  });

  it("allows IPv6-mapped loopback clients", async () => {
    const handled = await handleDiscoveryRequest("GET", "/api/discovery", deps(), "::ffff:127.0.0.1");
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ rankedCandidates: candidates }) });
  });

  it("falls through (null) for other paths and non-GET methods", async () => {
    expect(await handleDiscoveryRequest("GET", "/api/other", deps())).toBeNull();
    expect(await handleDiscoveryRequest("POST", "/api/discovery", deps())).toBeNull();
  });

  it("surfaces a store read failure as a 500 with a safe message", async () => {
    const handled = await handleDiscoveryRequest(
      "GET",
      "/api/discovery",
      deps({
        loadDiscoveredCandidatesModule: async () => {
          throw new Error("sqlite locked");
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });

  it("falls back to a generic message for a non-Error throw", async () => {
    const handled = await handleDiscoveryRequest(
      "GET",
      "/api/discovery",
      deps({
        loadDiscoveredCandidatesModule: async () => {
          throw "boom";
        },
      }),
    );
    expect(handled).toEqual({
      status: 500,
      body: JSON.stringify({ error: "failed to read local discovery candidates" }),
    });
  });
});
