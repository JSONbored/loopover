import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchContributorPrOutcomes } from "../../packages/loopover-miner/lib/pr-outcomes-client.js";
import type { ContributorPrOutcomes } from "../../packages/loopover-miner/lib/pr-outcomes-client.js";
import { parsePrOutcomesArgs, runPrOutcomes } from "../../packages/loopover-miner/lib/pr-outcomes-cli.js";

// resolveLoopoverBackendSession reads the on-disk loopover-mcp config; stage a temp config dir whose default
// profile carries an apiUrl + session token so the with-session branches run deterministically (no on-disk state).
const configDirs: string[] = [];

function sessionConfigDir(token = "sess-abc", apiUrl = "https://api.example.internal"): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "loopover-pr-outcomes-cfg-"));
  configDirs.push(dir);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ activeProfile: "default", profiles: { default: { apiUrl, session: { token } } } }),
    "utf8",
  );
  return { LOOPOVER_CONFIG_DIR: dir } as unknown as NodeJS.ProcessEnv;
}

let logs: string[] = [];
let errs: string[] = [];

function captureConsole() {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => void logs.push(String(msg)));
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => void errs.push(String(msg)));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of configDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SAMPLE: ContributorPrOutcomes = {
  login: "octocat",
  count: 2,
  summary: "LoopOver post-merge outcomes for octocat: 2 merged PR(s).",
  outcomes: [
    {
      repoFullName: "acme/widgets",
      pullNumber: 42,
      outcome: "merged",
      attribution: "octocat",
      deeplink: "https://github.com/acme/widgets/pull/42",
      recordedAt: "2026-07-01T00:00:00Z",
    },
    {
      repoFullName: "acme/gadgets",
      pullNumber: null,
      outcome: "merged",
      attribution: "octocat",
      deeplink: "https://github.com/acme/gadgets",
      recordedAt: "2026-07-02T00:00:00Z",
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("parsePrOutcomesArgs (#7658)", () => {
  it("requires --login", () => {
    expect(parsePrOutcomesArgs([])).toEqual({ error: expect.stringContaining("--login") });
    expect(parsePrOutcomesArgs(["--json"])).toEqual({ error: expect.stringContaining("--login") });
  });

  it("parses --login, --limit, and --json in any order", () => {
    expect(parsePrOutcomesArgs(["--login", "octocat"])).toEqual({ login: "octocat", json: false });
    expect(parsePrOutcomesArgs(["--json", "--login", "octocat", "--limit", "10"])).toEqual({
      login: "octocat",
      json: true,
      limit: 10,
    });
  });

  it("rejects a missing/dashed --login or --limit value", () => {
    expect(parsePrOutcomesArgs(["--login"])).toEqual({ error: expect.stringContaining("--login") });
    expect(parsePrOutcomesArgs(["--login", "--json"])).toEqual({ error: expect.stringContaining("--login") });
    expect(parsePrOutcomesArgs(["--login", "octocat", "--limit"])).toEqual({ error: expect.stringContaining("--login") });
    expect(parsePrOutcomesArgs(["--login", "octocat", "--limit", "-1"])).toEqual({ error: expect.stringContaining("--login") });
  });

  it("rejects an out-of-range or non-integer --limit", () => {
    for (const bad of ["0", "101", "3.5", "abc"]) {
      expect(parsePrOutcomesArgs(["--login", "octocat", "--limit", bad])).toEqual({
        error: expect.stringContaining("between 1 and 100"),
      });
    }
    // Boundaries are accepted.
    expect(parsePrOutcomesArgs(["--login", "octocat", "--limit", "1"])).toMatchObject({ limit: 1 });
    expect(parsePrOutcomesArgs(["--login", "octocat", "--limit", "100"])).toMatchObject({ limit: 100 });
  });

  it("rejects an unknown option", () => {
    expect(parsePrOutcomesArgs(["--login", "octocat", "--nope"])).toEqual({ error: "Unknown option: --nope" });
  });
});

describe("runPrOutcomes (#7658)", () => {
  it("prints a human-readable report by default (populated + null pull number)", async () => {
    captureConsole();
    const code = await runPrOutcomes(["--login", "octocat"], {
      fetchContributorPrOutcomes: async () => SAMPLE,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("2 merged PR(s).");
    expect(out).toContain("acme/widgets #42  merged  2026-07-01T00:00:00Z");
    expect(out).toContain("acme/gadgets #?  merged  2026-07-02T00:00:00Z");
  });

  it("prints the raw JSON payload with --json", async () => {
    captureConsole();
    const code = await runPrOutcomes(["--login", "octocat", "--json"], {
      fetchContributorPrOutcomes: async () => SAMPLE,
    });
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toEqual(SAMPLE);
  });

  it("renders a zero-outcome report (just the summary line)", async () => {
    captureConsole();
    const empty: ContributorPrOutcomes = { login: "octocat", count: 0, summary: "no merges yet", outcomes: [] };
    const code = await runPrOutcomes(["--login", "octocat"], { fetchContributorPrOutcomes: async () => empty });
    expect(code).toBe(0);
    expect(logs.join("\n")).toBe("no merges yet");
  });

  it("falls back to a synthesized summary and (unknown) fields when the payload omits them", async () => {
    captureConsole();
    const partial = {
      login: "octocat",
      count: 1,
      outcomes: [{ outcome: "merged" }],
    } as unknown as ContributorPrOutcomes;
    const code = await runPrOutcomes(["--login", "octocat"], { fetchContributorPrOutcomes: async () => partial });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("1 merged PR(s).");
    expect(out).toContain("(unknown) #?  merged  (unknown)");
  });

  it("forwards --limit to the client", async () => {
    const fetchOutcomes = vi.fn(async () => SAMPLE);
    await runPrOutcomes(["--login", "octocat", "--limit", "5"], { fetchContributorPrOutcomes: fetchOutcomes });
    expect(fetchOutcomes).toHaveBeenCalledWith("octocat", expect.objectContaining({ limit: 5 }));
    // Without --limit, the client is called without a limit key.
    const fetchNoLimit = vi.fn(async (_login: string, _opts?: unknown) => SAMPLE);
    await runPrOutcomes(["--login", "octocat"], { fetchContributorPrOutcomes: fetchNoLimit });
    expect(fetchNoLimit.mock.calls[0]?.[1] ?? {}).not.toHaveProperty("limit");
  });

  it("reports an argument error as a non-zero exit without calling the client", async () => {
    captureConsole();
    const fetchOutcomes = vi.fn(async () => SAMPLE);
    const code = await runPrOutcomes(["--nope"], { fetchContributorPrOutcomes: fetchOutcomes });
    expect(code).toBe(2);
    expect(fetchOutcomes).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("Unknown option: --nope");
  });

  it("reports a client failure (fail-loud) as a non-zero exit — JSON error on stdout with --json", async () => {
    captureConsole();
    const code = await runPrOutcomes(["--login", "octocat", "--json"], {
      fetchContributorPrOutcomes: async () => {
        throw new Error("no_loopover_session: run `loopover-mcp login` first");
      },
    });
    expect(code).toBe(2);
    // --json routes the failure to stdout as a parseable {ok:false,error} object (see reportCliFailure).
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: false, error: expect.stringContaining("no_loopover_session") });

    // Plain-text mode routes the same failure to stderr.
    captureConsole();
    const textCode = await runPrOutcomes(["--login", "octocat"], {
      fetchContributorPrOutcomes: async () => {
        throw new Error("pr-outcomes endpoint returned http_500 for octocat");
      },
    });
    expect(textCode).toBe(2);
    expect(errs.join("\n")).toContain("http_500");
  });
});

describe("fetchContributorPrOutcomes (#7658)", () => {
  it("rejects an empty login before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchContributorPrOutcomes("  ", { fetchImpl })).rejects.toThrow("non-empty login");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fetchContributorPrOutcomes(42 as unknown as string, { fetchImpl })).rejects.toThrow("non-empty login");
  });

  it("rejects an out-of-range limit before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchContributorPrOutcomes("octocat", { limit: 0, fetchImpl })).rejects.toThrow("between 1 and 100");
    await expect(fetchContributorPrOutcomes("octocat", { limit: 3.5, fetchImpl })).rejects.toThrow("between 1 and 100");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws no_loopover_session when no authenticated session resolves", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchContributorPrOutcomes("octocat", { env: { LOOPOVER_CONFIG_DIR: "/nonexistent-dir-xyz" } as unknown as NodeJS.ProcessEnv, fetchImpl }),
    ).rejects.toThrow("no_loopover_session");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the endpoint with Bearer auth, url-encoded login, and the limit query when a session resolves", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(SAMPLE);
    };
    const report = await fetchContributorPrOutcomes("Octo Cat", { env: sessionConfigDir(), fetchImpl, limit: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.internal/v1/contributors/Octo%20Cat/pr-outcomes?limit=10");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sess-abc");
    expect((calls[0]?.init.headers as Record<string, string>).accept).toBe("application/json");
    expect(report).toEqual(SAMPLE);
  });

  it("omits the limit query when no limit is given", async () => {
    const calls: string[] = [];
    await fetchContributorPrOutcomes("octocat", {
      env: sessionConfigDir(),
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse(SAMPLE);
      },
    });
    expect(calls[0]).toBe("https://api.example.internal/v1/contributors/octocat/pr-outcomes");
  });

  it("throws a fail-loud error on unreachable host, non-2xx, and malformed body", async () => {
    await expect(
      fetchContributorPrOutcomes("octocat", {
        env: sessionConfigDir(),
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow("unreachable");
    // A non-Error throw is surfaced via String(error), not error.message.
    await expect(
      fetchContributorPrOutcomes("octocat", {
        env: sessionConfigDir(),
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        fetchImpl: async () => {
          throw "raw-string-failure";
        },
      }),
    ).rejects.toThrow(/unreachable.*raw-string-failure/);
    await expect(
      fetchContributorPrOutcomes("octocat", { env: sessionConfigDir(), fetchImpl: async () => jsonResponse({ error: "nope" }, 404) }),
    ).rejects.toThrow("http_404");
    // Non-object and outcomes-not-an-array both count as malformed.
    await expect(
      fetchContributorPrOutcomes("octocat", { env: sessionConfigDir(), fetchImpl: async () => jsonResponse(null) }),
    ).rejects.toThrow("malformed");
    await expect(
      fetchContributorPrOutcomes("octocat", { env: sessionConfigDir(), fetchImpl: async () => jsonResponse({ login: "x" }) }),
    ).rejects.toThrow("malformed");
  });

  it("honors an explicit requestTimeoutMs (non-finite falls back to the default) without changing behavior", async () => {
    const report = await fetchContributorPrOutcomes("octocat", {
      env: sessionConfigDir(),
      fetchImpl: async () => jsonResponse(SAMPLE),
      requestTimeoutMs: 500,
    });
    expect(report).toEqual(SAMPLE);
    const report2 = await fetchContributorPrOutcomes("octocat", {
      env: sessionConfigDir(),
      fetchImpl: async () => jsonResponse(SAMPLE),
      requestTimeoutMs: Number.NaN,
    });
    expect(report2).toEqual(SAMPLE);
  });

  it("falls back to process.env and the real global fetch when neither env nor fetchImpl is injected", async () => {
    // process.env fallback: no `env` arg → reads process.env, which has no session → no_loopover_session,
    // BEFORE any fetch is attempted.
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    vi.stubEnv("LOOPOVER_CONFIG_DIR", "/nonexistent-dir-for-process-env-fallback");
    await expect(fetchContributorPrOutcomes("octocat")).rejects.toThrow("no_loopover_session");
    expect(globalFetch).not.toHaveBeenCalled();

    // real-global-fetch fallback: a resolvable session (via env) but no injected fetchImpl → the `?? fetch` arm.
    const stubbed = vi.fn(async () => jsonResponse(SAMPLE));
    vi.stubGlobal("fetch", stubbed);
    const report = await fetchContributorPrOutcomes("octocat", { env: sessionConfigDir() });
    expect(stubbed).toHaveBeenCalledTimes(1);
    expect(report).toEqual(SAMPLE);
  });
});
