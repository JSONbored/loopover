import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasGitHubTokenSource,
  resetGitHubTokenResolutionForTesting,
  resolveGitHubToken,
} from "../../packages/loopover-miner/lib/github-token-resolution.js";

function writeConfig(dir: string, config: unknown) {
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
}

function configuredEnv(dir: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { LOOPOVER_CONFIG_DIR: dir, ...overrides } as unknown as NodeJS.ProcessEnv;
}

describe("resolveGitHubToken (#6116)", () => {
  let dir: string;

  afterEach(() => {
    resetGitHubTokenResolutionForTesting();
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the real global fetch when no fetchImpl is injected", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-realfetch-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    let capturedUrl: string | undefined;
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return Response.json({ token: "live-token" });
    });
    await expect(resolveGitHubToken(configuredEnv(dir))).resolves.toBe("live-token");
    expect(capturedUrl).toBe("https://gittensory-api.aethereal.dev/v1/auth/github/token");
  });

  it("an explicit GITHUB_TOKEN env override wins outright, no filesystem or network access", async () => {
    const fetchImpl = () => {
      throw new Error("should never be called");
    };
    await expect(resolveGitHubToken({ GITHUB_TOKEN: "explicit-pat-token" } as unknown as NodeJS.ProcessEnv, { fetchImpl })).resolves.toBe("explicit-pat-token");
  });

  it("returns null when no config file exists at all", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-none-"));
    await expect(resolveGitHubToken(configuredEnv(dir))).resolves.toBeNull();
  });

  it("returns null when the config exists but the active profile has no session token", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-nosession-"));
    writeConfig(dir, { profiles: { default: { apiUrl: "https://api.example" } } });
    await expect(resolveGitHubToken(configuredEnv(dir))).resolves.toBeNull();
  });

  it("fetches a live token from the authenticated loopover-mcp session", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-fetch-"));
    writeConfig(dir, { profiles: { default: { apiUrl: "https://api.example", session: { token: "loopover-session-token" } } } });
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      capturedUrl = url;
      capturedAuth = init?.headers?.authorization;
      return Response.json({ token: "live-github-token" });
    };
    await expect(resolveGitHubToken(configuredEnv(dir), { fetchImpl })).resolves.toBe("live-github-token");
    expect(capturedUrl).toBe("https://api.example/v1/auth/github/token");
    expect(capturedAuth).toBe("Bearer loopover-session-token");
  });

  it("selects a named profile via LOOPOVER_PROFILE", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-profile-"));
    writeConfig(dir, {
      activeProfile: "default",
      profiles: {
        default: { apiUrl: "https://default.example", session: { token: "default-session" } },
        work: { apiUrl: "https://work.example", session: { token: "work-session" } },
      },
    });
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      capturedUrl = url;
      capturedAuth = init?.headers?.authorization;
      return Response.json({ token: "live-token" });
    };
    await resolveGitHubToken(configuredEnv(dir, { LOOPOVER_PROFILE: "work" }), { fetchImpl });
    expect(capturedUrl).toBe("https://work.example/v1/auth/github/token");
    expect(capturedAuth).toBe("Bearer work-session");
  });

  it("respects the config's own activeProfile when LOOPOVER_PROFILE is not set", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-active-"));
    writeConfig(dir, {
      activeProfile: "work",
      profiles: {
        default: { session: { token: "default-session" } },
        work: { apiUrl: "https://work.example", session: { token: "work-session" } },
      },
    });
    let capturedAuth: string | undefined;
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      capturedAuth = init?.headers?.authorization;
      return Response.json({ token: "live-token" });
    };
    await resolveGitHubToken(configuredEnv(dir), { fetchImpl });
    expect(capturedAuth).toBe("Bearer work-session");
  });

  it("LOOPOVER_API_URL env override wins over the profile's own apiUrl", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-apiurl-env-"));
    writeConfig(dir, { profiles: { default: { apiUrl: "https://profile.example", session: { token: "session-token" } } } });
    let capturedUrl: string | undefined;
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return Response.json({ token: "live-token" });
    };
    await resolveGitHubToken(configuredEnv(dir, { LOOPOVER_API_URL: "https://env-override.example/" }), { fetchImpl });
    expect(capturedUrl).toBe("https://env-override.example/v1/auth/github/token");
  });

  it("falls back to the default API URL when neither an env override nor a profile apiUrl is set", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-default-url-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    let capturedUrl: string | undefined;
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return Response.json({ token: "live-token" });
    };
    await resolveGitHubToken(configuredEnv(dir), { fetchImpl });
    expect(capturedUrl).toBe("https://gittensory-api.aethereal.dev/v1/auth/github/token");
  });

  it("treats a legacy default API URL stored in the profile as absent, falling through to the current default", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-legacy-url-"));
    writeConfig(dir, { profiles: { default: { apiUrl: "https://gittensory-api.zeronode.workers.dev", session: { token: "session-token" } } } });
    let capturedUrl: string | undefined;
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return Response.json({ token: "live-token" });
    };
    await resolveGitHubToken(configuredEnv(dir), { fetchImpl });
    expect(capturedUrl).toBe("https://gittensory-api.aethereal.dev/v1/auth/github/token");
  });

  it("returns null (not throw) when the fetch itself rejects", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-neterror-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    await expect(resolveGitHubToken(configuredEnv(dir), { fetchImpl })).resolves.toBeNull();
  });

  it("returns null when the response is not ok", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-notok-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    const fetchImpl = async () => Response.json({ error: "github_token_unavailable" }, { status: 404 });
    await expect(resolveGitHubToken(configuredEnv(dir), { fetchImpl })).resolves.toBeNull();
  });

  it("returns null when the response body is not valid JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-badjson-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    const fetchImpl = async () => new Response("{", { status: 200 });
    await expect(resolveGitHubToken(configuredEnv(dir), { fetchImpl })).resolves.toBeNull();
  });

  it("returns null when the response is ok but has no token field", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-notoken-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    const fetchImpl = async () => Response.json({});
    await expect(resolveGitHubToken(configuredEnv(dir), { fetchImpl })).resolves.toBeNull();
  });

  it("caches a SUCCESSFUL resolution for the process lifetime -- a second call does not re-fetch", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-cache-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return Response.json({ token: "live-token" });
    };
    const env = configuredEnv(dir);
    await expect(resolveGitHubToken(env, { fetchImpl })).resolves.toBe("live-token");
    await expect(resolveGitHubToken(env, { fetchImpl })).resolves.toBe("live-token");
    expect(calls).toBe(1);
  });

  it("does NOT cache a failed resolution -- the next call retries (self-heals from a transient failure)", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-retry-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1 ? Response.json({}, { status: 502 }) : Response.json({ token: "recovered-token" });
    };
    const env = configuredEnv(dir);
    await expect(resolveGitHubToken(env, { fetchImpl })).resolves.toBeNull();
    await expect(resolveGitHubToken(env, { fetchImpl })).resolves.toBe("recovered-token");
    expect(calls).toBe(2);
  });

  it("resetGitHubTokenResolutionForTesting clears a cached successful resolution", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-reset-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return Response.json({ token: "live-token" });
    };
    const env = configuredEnv(dir);
    await resolveGitHubToken(env, { fetchImpl });
    resetGitHubTokenResolutionForTesting();
    await resolveGitHubToken(env, { fetchImpl });
    expect(calls).toBe(2);
  });

  it("degrades to an empty config (no crash) when the config file contains malformed JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-malformed-"));
    writeFileSync(join(dir, "config.json"), "{not valid json", { mode: 0o600 });
    await expect(resolveGitHubToken(configuredEnv(dir))).resolves.toBeNull();
  });

  it("degrades to an empty config when the config file's top-level JSON is not an object", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-arrayjson-"));
    writeFileSync(join(dir, "config.json"), "[1,2,3]", { mode: 0o600 });
    await expect(resolveGitHubToken(configuredEnv(dir))).resolves.toBeNull();
  });

  it("falls back to XDG_CONFIG_HOME when neither LOOPOVER_CONFIG_PATH nor LOOPOVER_CONFIG_DIR is set", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-xdg-"));
    const loopoverConfigDir = join(dir, "loopover");
    mkdirSync(loopoverConfigDir, { recursive: true });
    writeConfig(loopoverConfigDir, { profiles: { default: { session: { token: "session-token" } } } });
    const fetchImpl = async () => Response.json({ token: "live-token" });
    await expect(
      resolveGitHubToken({ XDG_CONFIG_HOME: dir } as unknown as NodeJS.ProcessEnv, { fetchImpl }),
    ).resolves.toBe("live-token");
  });

  it("LOOPOVER_CONFIG_PATH reaches a specific file directly, independent of LOOPOVER_CONFIG_DIR", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-configpath-"));
    const file = join(dir, "custom-config.json");
    writeFileSync(file, JSON.stringify({ profiles: { default: { session: { token: "session-token" } } } }), { mode: 0o600 });
    const fetchImpl = async () => Response.json({ token: "live-token" });
    await expect(resolveGitHubToken({ LOOPOVER_CONFIG_PATH: file, LOOPOVER_CONFIG_DIR: "" } as unknown as NodeJS.ProcessEnv, { fetchImpl })).resolves.toBe("live-token");
  });

  it("an invalid LOOPOVER_PROFILE name falls back to the default profile rather than throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-badprofile-"));
    writeConfig(dir, { profiles: { default: { session: { token: "default-session" } } } });
    let capturedAuth: string | undefined;
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      capturedAuth = init?.headers?.authorization;
      return Response.json({ token: "live-token" });
    };
    await resolveGitHubToken(configuredEnv(dir, { LOOPOVER_PROFILE: "Not A Valid Name!!" }), { fetchImpl });
    expect(capturedAuth).toBe("Bearer default-session");
  });
});

describe("hasGitHubTokenSource (#6116)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is true when GITHUB_TOKEN is set, even with no config file on disk", () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-source-envonly-"));
    expect(hasGitHubTokenSource(configuredEnv(dir, { GITHUB_TOKEN: "explicit-pat-token" }))).toBe(true);
  });

  it("is true when no GITHUB_TOKEN is set but a loopover-mcp session token is recorded", () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-source-session-"));
    writeConfig(dir, { profiles: { default: { session: { token: "session-token" } } } });
    expect(hasGitHubTokenSource(configuredEnv(dir))).toBe(true);
  });

  it("is false when neither GITHUB_TOKEN nor a loopover-mcp session is available", () => {
    dir = mkdtempSync(join(tmpdir(), "loopover-miner-github-token-source-none-"));
    expect(hasGitHubTokenSource(configuredEnv(dir))).toBe(false);
  });
});
