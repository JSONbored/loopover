import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit, verifyGithubToken } from "../../packages/gittensory-miner/lib/laptop-init.js";

const tempDirs = new Set<string>();

function makeTempEnv() {
  const configDir = mkdtempSync(join(tmpdir(), "gittensory-miner-init-"));
  tempDirs.add(configDir);
  return {
    env: {
      ...process.env,
      GITTENSORY_MINER_CONFIG_DIR: configDir,
    },
    configDir,
    dbPath: join(configDir, "laptop-state.sqlite3"),
  };
}

function mockJsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("verifyGithubToken", () => {
  it("trims the API base URL and omits Authorization when the token is blank", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return mockJsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "repo" } });
    };

    const result = await verifyGithubToken({
      githubToken: "   ",
      apiBaseUrl: "https://example.com/",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(requests).toEqual([
      {
        url: "https://example.com/user",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "loopover-miner",
          "x-github-api-version": "2022-11-28",
        },
      },
    ]);
  });

  it("accepts a valid token, returning the reported scopes and login", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "repo, read:org" } }),
    );

    const result = await verifyGithubToken({ githubToken: "token-value" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.login).toBe("octocat");
    expect(result.scopes).toEqual(["repo", "read:org"]);
    expect(result.detail).toContain("octocat");
    expect(result.detail).toContain("repo, read:org");
  });

  it("still succeeds when GitHub does not report classic OAuth scopes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse({ login: "octocat" }));

    const result = await verifyGithubToken({ githubToken: "token-value" });

    expect(result.ok).toBe(true);
    expect(result.login).toBe("octocat");
    expect(result.scopes).toEqual([]);
    expect(result.detail).toContain("did not report classic OAuth scopes");
  });

  it("rejects an explicitly empty x-oauth-scopes header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "" } }),
    );

    const result = await verifyGithubToken({ githubToken: "token-value" });

    expect(result.ok).toBe(false);
    expect(result.login).toBe("octocat");
    expect(result.scopes).toEqual([]);
    expect(result.detail).toContain("empty x-oauth-scopes header");
  });

  it("rejects a token when GitHub reports only non-repository scopes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "read:org" } }),
    );

    const result = await verifyGithubToken({ githubToken: "token-value" });

    expect(result.ok).toBe(false);
    expect(result.login).toBe("octocat");
    expect(result.scopes).toEqual(["read:org"]);
    expect(result.detail).toContain("reissue it with repo access");
  });

  it("surfaces a rejected token as a clear GitHub error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ message: "Bad credentials" }, { status: 401 }),
    );

    const result = await verifyGithubToken({ githubToken: "token-value" });

    expect(result.ok).toBe(false);
    expect(result.login).toBeNull();
    expect(result.detail).toContain("Bad credentials");
  });

  it("falls back to the HTTP status when GitHub returns an error without a message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse({}, { status: 403 }));

    const result = await verifyGithubToken({ githubToken: "token-value" });

    expect(result.ok).toBe(false);
    expect(result.login).toBeNull();
    expect(result.detail).toContain("GitHub returned HTTP 403");
  });

  it("surfaces network errors as a validation failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    const result = await verifyGithubToken({ githubToken: "token-value" });

    expect(result.ok).toBe(false);
    expect(result.login).toBeNull();
    expect(result.detail).toContain("ECONNRESET");
  });

  it("times out when the GitHub request never settles", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });

    const result = await verifyGithubToken({
      githubToken: "token-value",
      fetchImpl,
      timeoutMs: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.login).toBeNull();
    expect(result.detail).toContain("timed out after 1ms");
  });
});

describe("runInit", () => {
  it("keeps the default init path offline and byte-stable", async () => {
    const { env, configDir, dbPath } = makeTempEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse({ login: "octocat" }));

    const exitCode = await runInit([], env);

    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const firstLog = logSpy.mock.calls[0];
    const secondLog = logSpy.mock.calls[1];
    if (!firstLog || !secondLog) throw new Error("expected two init log lines");
    expect(logSpy.mock.calls.map(([line]) => line)).toEqual([
      `initialized ${configDir}`,
      `sqlite: ${dbPath}`,
    ]);
  });

  it("preserves the JSON shape when --json is present without token verification", async () => {
    const { env, configDir, dbPath } = makeTempEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse({ login: "octocat" }));

    const exitCode = await runInit(["--json"], env);

    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const jsonLog = logSpy.mock.calls[0];
    if (!jsonLog) throw new Error("expected one JSON init log line");
    expect(JSON.parse(String(jsonLog[0]))).toEqual({
      stateDir: configDir,
      dbPath,
      created: true,
    });
  });

  it("runs exactly one GitHub API call when --verify-token is requested", async () => {
    const { env, configDir, dbPath } = makeTempEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "repo, read:org" } }),
    );

    const exitCode = await runInit(["--verify-token"], env);

    expect(exitCode).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstFetchCall = fetchSpy.mock.calls[0];
    if (!firstFetchCall) throw new Error("expected one GitHub token verification call");
    expect(String(firstFetchCall[0])).toBe("https://api.github.com/user");
    const firstInitLog = logSpy.mock.calls[0];
    const secondInitLog = logSpy.mock.calls[1];
    const tokenLog = logSpy.mock.calls[2];
    if (!firstInitLog || !secondInitLog || !tokenLog) throw new Error("expected three init log lines");
    expect(logSpy.mock.calls.map(([line]) => line)).toEqual([
      `initialized ${configDir}`,
      `sqlite: ${dbPath}`,
      "token: validated GitHub token for octocat; scopes: repo, read:org",
    ]);
  });

  it("includes token verification data in JSON output when --json and --verify-token are both set", async () => {
    const { env, configDir, dbPath } = makeTempEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "repo, read:org" } }),
    );

    const exitCode = await runInit(["--json", "--verify-token"], env);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const jsonLog = logSpy.mock.calls[0];
    if (!jsonLog) throw new Error("expected one JSON init log line");
    expect(JSON.parse(String(jsonLog[0]))).toEqual({
      stateDir: configDir,
      dbPath,
      created: true,
      tokenVerification: {
        ok: true,
        login: "octocat",
        scopes: ["repo", "read:org"],
        detail: "validated GitHub token for octocat; scopes: repo, read:org",
      },
    });
  });

  it("stops before init when token verification fails", async () => {
    const { env } = makeTempEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ message: "Bad credentials" }, { status: 401 }),
    );

    const exitCode = await runInit(["--verify-token"], env);

    expect(exitCode).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "GITHUB_TOKEN verification failed: Bad credentials",
    );
  });

  it("emits JSON when token verification fails with --json (#4836)", async () => {
    const { env } = makeTempEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse({ message: "Bad credentials" }, { status: 401 }),
    );

    const exitCode = await runInit(["--json", "--verify-token"], env);

    expect(exitCode).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "GITHUB_TOKEN verification failed: Bad credentials",
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
