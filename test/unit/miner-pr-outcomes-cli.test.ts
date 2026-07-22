import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../packages/loopover-miner/lib/cli.js";
import {
  parsePrOutcomesArgs,
  renderPrOutcomesText,
  runPrOutcomesCli,
} from "../../packages/loopover-miner/lib/pr-outcomes-cli.js";
import type { PrOutcomesFetch, PrOutcomesPayload } from "../../packages/loopover-miner/lib/pr-outcomes-cli.js";

// #7658: the miner's own hosted post-merge outcomes over the CLI. Every HTTP interaction is driven through an
// injected fetch (no live network), mirroring tenant-cli's injectable-client test conventions.

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = { apiUrl: "https://api.loopover.test", sessionToken: "session-token-1" };

const PAYLOAD: PrOutcomesPayload = {
  login: "octominer",
  count: 2,
  summary: "LoopOver post-merge outcomes for octominer: 2 merged PR(s).",
  outcomes: [
    {
      repoFullName: "acme/widgets",
      pullNumber: 41,
      outcome: "merged",
      attribution: "merged into acme/widgets",
      deeplink: "https://github.com/acme/widgets/pull/41",
      recordedAt: "2026-07-20T00:00:00.000Z",
    },
    {
      repoFullName: "acme/legacy",
      pullNumber: null,
      outcome: "merged",
      attribution: "merged into acme/legacy",
      deeplink: "https://github.com/acme/legacy",
      recordedAt: "2026-07-19T00:00:00.000Z",
    },
  ],
};

function fetchReturning(payload: unknown, status = 200): { fetchImpl: PrOutcomesFetch; requests: Array<{ url: string; init?: unknown }> } {
  const requests: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl: PrOutcomesFetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, requests };
}

describe("parsePrOutcomesArgs (#7658)", () => {
  it("parses login, limit, and json together", () => {
    expect(parsePrOutcomesArgs(["--miner-login", "octominer", "--limit", "5", "--json"])).toEqual({
      minerLogin: "octominer",
      limit: 5,
      json: true,
    });
  });

  it("defaults limit to null and json to false", () => {
    expect(parsePrOutcomesArgs(["--miner-login", "octominer"])).toEqual({ minerLogin: "octominer", limit: null, json: false });
  });

  it("requires --miner-login", () => {
    expect(parsePrOutcomesArgs([])).toEqual({ error: expect.stringContaining("--miner-login is required") });
  });

  it("rejects a --miner-login without a value (including a following flag)", () => {
    expect(parsePrOutcomesArgs(["--miner-login"])).toEqual({ error: expect.stringContaining("--miner-login requires a value") });
    expect(parsePrOutcomesArgs(["--miner-login", "--json"])).toEqual({ error: expect.stringContaining("--miner-login requires a value") });
  });

  it("rejects non-integer, out-of-range, and missing --limit values (mirroring the route's own validation)", () => {
    for (const bad of [["--limit"], ["--limit", "0"], ["--limit", "101"], ["--limit", "1.5"], ["--limit", "abc"]]) {
      expect(parsePrOutcomesArgs(["--miner-login", "octominer", ...bad])).toEqual({
        error: expect.stringContaining("--limit must be an integer between 1 and 100"),
      });
    }
  });

  it("rejects unknown options and unexpected positionals", () => {
    expect(parsePrOutcomesArgs(["--miner-login", "octominer", "--bogus"])).toEqual({ error: expect.stringContaining("Unknown option: --bogus") });
    expect(parsePrOutcomesArgs(["--miner-login", "octominer", "stray"])).toEqual({ error: expect.stringContaining("Unexpected argument: stray") });
  });
});

describe("renderPrOutcomesText (#7658)", () => {
  it("renders the summary plus one line per outcome, dropping the #pull suffix for a null pullNumber", () => {
    const text = renderPrOutcomesText(PAYLOAD);
    expect(text).toContain("2 merged PR(s)");
    expect(text).toContain("- acme/widgets#41 merged 2026-07-20T00:00:00.000Z https://github.com/acme/widgets/pull/41");
    expect(text).toContain("- acme/legacy merged 2026-07-19T00:00:00.000Z https://github.com/acme/legacy");
    expect(text).not.toContain("acme/legacy#");
  });
});

describe("runPrOutcomesCli (#7658)", () => {
  it("fetches the miner's own outcomes with the session bearer token and prints the text view", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { fetchImpl, requests } = fetchReturning(PAYLOAD);
    const code = await runPrOutcomesCli(["--miner-login", "octominer"], { fetchImpl, resolveSession: () => SESSION });
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.loopover.test/v1/contributors/octominer/pr-outcomes");
    expect((requests[0]!.init as { headers: Record<string, string> }).headers).toMatchObject({
      authorization: "Bearer session-token-1",
      accept: "application/json",
    });
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("2 merged PR(s)");
    expect(text).toContain("- acme/widgets#41 merged");
    expect(text).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("forwards --limit as the route's ?limit query and encodes the login", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { fetchImpl, requests } = fetchReturning({ ...PAYLOAD, outcomes: [] });
    const code = await runPrOutcomesCli(["--miner-login", "octo miner", "--limit", "5"], { fetchImpl, resolveSession: () => SESSION });
    expect(code).toBe(0);
    expect(requests[0]!.url).toBe("https://api.loopover.test/v1/contributors/octo%20miner/pr-outcomes?limit=5");
  });

  it("emits the raw payload under --json", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { fetchImpl } = fetchReturning(PAYLOAD);
    const code = await runPrOutcomesCli(["--miner-login", "octominer", "--json"], { fetchImpl, resolveSession: () => SESSION });
    expect(code).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(PAYLOAD);
  });

  it("reports a usage error as exit 1 (JSON-shaped under --json)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runPrOutcomesCli(["--json"])).resolves.toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
    await expect(runPrOutcomesCli([])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--miner-login is required"));
  });

  it("fails loud with a login hint when no LoopOver session exists on disk (real resolver, empty config dir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miner-pr-outcomes-cli-"));
    tempDirs.push(dir);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runPrOutcomesCli(["--miner-login", "octominer"], { env: { ...process.env, LOOPOVER_CONFIG_DIR: dir } });
    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("loopover-mcp login"));
  });

  it("reports a non-2xx response as a failure with the HTTP status and body detail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fetchImpl } = fetchReturning({ error: "forbidden_contributor" }, 403);
    const code = await runPrOutcomesCli(["--miner-login", "octominer"], { fetchImpl, resolveSession: () => SESSION });
    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("HTTP 403"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("forbidden_contributor"));
  });

  it("falls back to the global fetch when no fetchImpl is injected (stubbed, no live network)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => PAYLOAD, text: async () => "" })),
    );
    try {
      const code = await runPrOutcomesCli(["--miner-login", "octominer", "--json"], { resolveSession: () => SESSION });
      expect(code).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ login: "octominer" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a thrown fetch failure (network/timeout) via the shared CLI error shape", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl: PrOutcomesFetch = async () => {
      throw new Error("fetch failed: connect ECONNREFUSED");
    };
    const code = await runPrOutcomesCli(["--miner-login", "octominer"], { fetchImpl, resolveSession: () => SESSION });
    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });
});

describe("runCli pr-outcomes dispatch (#7658)", () => {
  it("dispatches pr-outcomes through the foundation CLI module", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { fetchImpl, requests } = fetchReturning(PAYLOAD);
    const code = await runCli(["pr-outcomes", "--miner-login", "octominer", "--json"], { packageName: "@loopover/miner" }, {
      fetchImpl,
      resolveSession: () => SESSION,
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ login: "octominer", count: 2 });
  });
});
