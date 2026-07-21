import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchContributorPrOutcomes } from "../../packages/loopover-miner/lib/pr-outcomes-client.js";
import {
  parsePrOutcomesArgs,
  resolvePrOutcomesLogin,
  runPrOutcomes,
  runPrOutcomesCli,
} from "../../packages/loopover-miner/lib/pr-outcomes-cli.js";

const AUTH = { apiUrl: "https://orb.example", sessionToken: "session-secret" };

const SAMPLE_PAYLOAD = {
  login: "minerbot",
  count: 1,
  summary: "1 merged PR outcome for minerbot.",
  outcomes: [
    {
      repoFullName: "acme/widgets",
      pullNumber: 42,
      outcome: "merged" as const,
      attribution: "Merged #42 into main.",
      deeplink: "https://github.com/acme/widgets/pull/42",
      recordedAt: "2026-07-20T12:00:00.000Z",
    },
  ],
};

let logs: string[] = [];
let errs: string[] = [];

function captureConsole() {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errs.push(String(msg));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parsePrOutcomesArgs (#7658)", () => {
  it("accepts --login, --miner-login, --limit, and --json", () => {
    expect(parsePrOutcomesArgs(["--login", "alice", "--limit", "10", "--json"])).toEqual({
      login: "alice",
      limit: 10,
      json: true,
    });
    expect(parsePrOutcomesArgs(["--miner-login", "bob"])).toEqual({
      login: "bob",
      limit: undefined,
      json: false,
    });
  });

  it("rejects an out-of-range --limit and unknown flags", () => {
    expect(parsePrOutcomesArgs(["--limit", "0"])).toEqual({
      error: "Pass --limit as an integer between 1 and 100.",
    });
    expect(parsePrOutcomesArgs(["--limit", "101"])).toEqual({
      error: "Pass --limit as an integer between 1 and 100.",
    });
    expect(parsePrOutcomesArgs(["--bogus"])).toEqual({ error: "Unknown option: --bogus" });
  });
});

describe("resolvePrOutcomesLogin (#7658)", () => {
  it("prefers the explicit flag, then LOOPOVER_LOGIN, then GITHUB_LOGIN", () => {
    expect(
      resolvePrOutcomesLogin("explicit", {
        LOOPOVER_LOGIN: "from-loopover",
        GITHUB_LOGIN: "from-gh",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("explicit");
    expect(
      resolvePrOutcomesLogin(null, {
        LOOPOVER_LOGIN: "from-loopover",
        GITHUB_LOGIN: "from-gh",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("from-loopover");
    expect(resolvePrOutcomesLogin(null, { GITHUB_LOGIN: "from-gh" } as unknown as NodeJS.ProcessEnv)).toBe("from-gh");
    expect(resolvePrOutcomesLogin(null, {} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("fetchContributorPrOutcomes (#7658)", () => {
  it("GETs the hosted path with Bearer auth and optional limit", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://orb.example/v1/contributors/minerbot/pr-outcomes?limit=5");
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer session-secret");
      return Response.json(SAMPLE_PAYLOAD);
    });
    const payload = await fetchContributorPrOutcomes("minerbot", {
      loopoverAuth: AUTH,
      fetchImpl,
      limit: 5,
    });
    expect(payload).toEqual(SAMPLE_PAYLOAD);
  });

  it("URL-encodes the login path segment", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://orb.example/v1/contributors/weird%2Flogin/pr-outcomes");
      return Response.json({ ...SAMPLE_PAYLOAD, login: "weird/login", outcomes: [] });
    });
    await fetchContributorPrOutcomes("weird/login", { loopoverAuth: AUTH, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails loud when there is no session", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchContributorPrOutcomes("minerbot", {
        env: {} as unknown as NodeJS.ProcessEnv,
        fetchImpl,
        loopoverAuth: null,
      }),
    ).rejects.toThrow(/no loopover session/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails loud on a bad limit before touching the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchContributorPrOutcomes("minerbot", { loopoverAuth: AUTH, fetchImpl, limit: 0 }),
    ).rejects.toThrow(/limit must be an integer between 1 and 100/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails loud on non-2xx, unreachable, and malformed bodies", async () => {
    await expect(
      fetchContributorPrOutcomes("minerbot", {
        loopoverAuth: AUTH,
        fetchImpl: async () => new Response("nope", { status: 403 }),
      }),
    ).rejects.toThrow(/http_403/);

    await expect(
      fetchContributorPrOutcomes("minerbot", {
        loopoverAuth: AUTH,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toThrow(/unreachable.*network down/);

    await expect(
      fetchContributorPrOutcomes("minerbot", {
        loopoverAuth: AUTH,
        fetchImpl: async () => new Response("not-json", { status: 200 }),
      }),
    ).rejects.toThrow(/malformed response/);

    await expect(
      fetchContributorPrOutcomes("minerbot", {
        loopoverAuth: AUTH,
        fetchImpl: async () => Response.json(["not", "an", "object"]),
      }),
    ).rejects.toThrow(/malformed response/);
  });
});

describe("runPrOutcomes CLI (#7658)", () => {
  it("prints the summary + merged rows in text mode", async () => {
    captureConsole();
    const code = await runPrOutcomes(["--login", "minerbot"], {
      loopoverAuth: AUTH,
      fetchContributorPrOutcomes: async () => SAMPLE_PAYLOAD,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("1 merged PR outcome for minerbot.");
    expect(logs.join("\n")).toContain("acme/widgets#42 [merged]");
    expect(logs.join("\n")).toContain("Merged #42 into main.");
  });

  it("prints JSON when --json is set", async () => {
    captureConsole();
    const code = await runPrOutcomes(["--login", "minerbot", "--json"], {
      loopoverAuth: AUTH,
      fetchContributorPrOutcomes: async () => SAMPLE_PAYLOAD,
    });
    expect(code).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual(SAMPLE_PAYLOAD);
  });

  it("fails when login cannot be resolved", async () => {
    captureConsole();
    const code = await runPrOutcomesCli([], { env: {} as unknown as NodeJS.ProcessEnv, loopoverAuth: AUTH });
    expect(code).not.toBe(0);
    expect(errs.join("\n")).toMatch(/Pass --login/);
  });

  it("surfaces client errors as a non-zero exit", async () => {
    captureConsole();
    const code = await runPrOutcomes(["--login", "minerbot", "--json"], {
      loopoverAuth: AUTH,
      fetchContributorPrOutcomes: async () => {
        throw new Error("pr-outcomes returned http_401");
      },
    });
    expect(code).not.toBe(0);
    expect(errs.join("\n") + logs.join("\n")).toMatch(/http_401/);
  });

  it("forwards --limit into the client call", async () => {
    captureConsole();
    let seenLimit: number | undefined;
    const code = await runPrOutcomes(["--login", "minerbot", "--limit", "7"], {
      loopoverAuth: AUTH,
      fetchContributorPrOutcomes: async (_login, options = {}) => {
        seenLimit = options.limit;
        return SAMPLE_PAYLOAD;
      },
    });
    expect(code).toBe(0);
    expect(seenLimit).toBe(7);
  });
});
