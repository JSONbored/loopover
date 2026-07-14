import { describe, expect, it, vi } from "vitest";

import {
  handleRankedCandidatesRequest,
  rankedCandidatesApiPlugin,
  type RankedCandidatesApiDeps,
} from "../vite-ranked-candidates-api";

const candidates = [
  {
    repoFullName: "acme/widgets",
    issueNumber: 1,
    title: "Add retry helper",
    htmlUrl: "https://github.com/acme/widgets/issues/1",
    rankScore: 0.81,
    laneFit: 0.9,
    freshness: 0.7,
    potential: 0.85,
    feasibility: 0.6,
    dupRisk: 0.1,
    rankedAt: "2026-07-13T12:00:00.000Z",
  },
];

function deps(overrides: Partial<RankedCandidatesApiDeps> = {}): RankedCandidatesApiDeps {
  return {
    loadRankedCandidatesModule: async () => ({
      resolveRankedCandidatesDbPath: () => "/home/miner/.config/loopover-miner/ranked-candidates.sqlite3",
      listRankedCandidates: () => candidates,
    }),
    fileExists: () => true,
    ...overrides,
  };
}

describe("handleRankedCandidatesRequest (#4859 prerequisite)", () => {
  it("serves the last discover run's ranked candidates via the existing ranked-candidates.js exports", async () => {
    const handled = await handleRankedCandidatesRequest("GET", "/api/ranked-candidates", deps());
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ candidates }) });
  });

  it("serves an empty snapshot on a fresh install WITHOUT initializing the store (no DB file => no listRankedCandidates call)", async () => {
    let listed = false;
    const handled = await handleRankedCandidatesRequest(
      "GET",
      "/api/ranked-candidates",
      deps({
        loadRankedCandidatesModule: async () => ({
          resolveRankedCandidatesDbPath: () => "/nowhere/ranked-candidates.sqlite3",
          listRankedCandidates: () => {
            listed = true;
            return candidates;
          },
        }),
        fileExists: () => false,
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ candidates: [] }) });
    expect(listed).toBe(false);
  });

  it("falls through (null) for other paths and non-GET methods", async () => {
    expect(await handleRankedCandidatesRequest("GET", "/api/other", deps())).toBeNull();
    expect(await handleRankedCandidatesRequest("POST", "/api/ranked-candidates", deps())).toBeNull();
  });

  it("treats a method-less request (method undefined) the same as GET", async () => {
    const handled = await handleRankedCandidatesRequest(undefined, "/api/ranked-candidates", deps());
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ candidates }) });
  });

  it("surfaces a store read failure as a 500 with a safe message", async () => {
    const handled = await handleRankedCandidatesRequest(
      "GET",
      "/api/ranked-candidates",
      deps({
        loadRankedCandidatesModule: async () => {
          throw new Error("sqlite locked");
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });
});

type CapturedRequestHandler = (
  req: { method?: string; url?: string },
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
  next: () => void,
) => void;

function fakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let ended: string | undefined;
  return {
    res: {
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      end: (body: string) => {
        ended = body;
      },
    },
    headers,
    getEnded: () => ended,
    getStatus: () => statusCode,
  };
}

describe("rankedCandidatesApiPlugin (#4859 prerequisite)", () => {
  function captureMiddleware(overrides: Partial<RankedCandidatesApiDeps> = {}): CapturedRequestHandler {
    let captured: CapturedRequestHandler | undefined;
    const plugin = rankedCandidatesApiPlugin(deps(overrides));
    const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
    // @ts-expect-error -- the test double only implements the subset of Vite's ViteDevServer this plugin reads.
    plugin.configureServer(server);
    if (!captured) throw new Error("rankedCandidatesApiPlugin did not register a middleware");
    return captured;
  }

  it("serves the real (injected) store's candidates for a matching GET request", async () => {
    const middleware = captureMiddleware();
    const { res, getEnded, getStatus } = fakeResponse();
    let calledNext = false;
    middleware({ method: "GET", url: "/api/ranked-candidates" }, res, () => {
      calledNext = true;
    });
    await vi.waitFor(() => expect(getEnded()).toBeDefined());
    expect(getStatus()).toBe(200);
    expect(JSON.parse(getEnded() ?? "{}")).toEqual({ candidates });
    expect(calledNext).toBe(false);
  });

  it("falls through to next() for a non-matching request", async () => {
    const middleware = captureMiddleware();
    const { res } = fakeResponse();
    let calledNext = false;
    await new Promise<void>((resolve) => {
      middleware({ method: "GET", url: "/api/other" }, res, () => {
        calledNext = true;
        resolve();
      });
    });
    expect(calledNext).toBe(true);
  });

  it("also attaches via configurePreviewServer for `vite preview`", () => {
    let captured: CapturedRequestHandler | undefined;
    const plugin = rankedCandidatesApiPlugin(deps());
    const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
    // @ts-expect-error -- same partial test double as configureServer above.
    plugin.configurePreviewServer(server);
    expect(captured).toBeTypeOf("function");
  });
});
