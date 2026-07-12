import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadFileCredentials } from "../../packages/gittensory-miner/lib/load-file-credentials.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadFileCredentials (miner fleet-mode secret-file indirection, #5178)", () => {
  it("leaves an existing plain env var untouched (no regression to today's behavior)", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN: "plain-tok" };
    loadFileCredentials(env, () => "from-file");
    expect(env.GITHUB_TOKEN).toBe("plain-tok");
  });

  it("reads via the real readFileSync default when no reader is injected (exercises the default path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "miner-cred-"));
    const file = join(dir, "github_token");
    writeFileSync(file, "real-file-token\n");
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: file };
    try {
      loadFileCredentials(env); // no injected reader → the default readFileSync path runs against a real file
      expect(env.GITHUB_TOKEN).toBe("real-file-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves <NAME>_FILE into <NAME> (trimmed) when the plain var is unset", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    const readFile = vi.fn(() => "file-tok\n");
    loadFileCredentials(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("file-tok");
    expect(readFile).toHaveBeenCalledWith("/run/secrets/github_token");
  });

  it("lets an explicit plain <NAME> win over <NAME>_FILE (documented precedence, no file read)", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "explicit",
      GITHUB_TOKEN_FILE: "/run/secrets/github_token",
    };
    const readFile = vi.fn(() => "file-tok");
    loadFileCredentials(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("explicit");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("treats an explicitly-set EMPTY plain <NAME> as present, so it still wins over <NAME>_FILE (presence, not truthiness)", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "",
      GITHUB_TOKEN_FILE: "/run/secrets/github_token",
    };
    const readFile = vi.fn(() => "file-tok");
    loadFileCredentials(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does nothing when neither <NAME> nor <NAME>_FILE is set", () => {
    const env: Record<string, string | undefined> = { UNRELATED: "x" };
    loadFileCredentials(env, () => "unused");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("resolves a coding-agent credential file (empty file → empty string, not undefined)", () => {
    const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN_FILE: "/run/secrets/claude" };
    loadFileCredentials(env, () => "   \n");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  });

  it("throws a clear, path-identifying error when the _FILE path is unreadable (no silent fallthrough)", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/missing" };
    expect(() =>
      loadFileCredentials(env, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/GITHUB_TOKEN_FILE.*\/run\/secrets\/missing/);
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("only touches the credential allowlist — unrelated *_FILE env vars (OS/Compose) are never read", () => {
    const env: Record<string, string | undefined> = {
      COMPOSE_FILE: "a.yml:b.yml",
      GIO_LAUNCHED_DESKTOP_FILE: "/usr/share/applications/x.desktop",
      SOME_OTHER_FILE: "/etc/hostname",
    };
    const readFile = vi.fn(() => "should-not-be-read");
    loadFileCredentials(env, readFile);
    expect(readFile).not.toHaveBeenCalled();
    expect(env.COMPOSE).toBeUndefined();
    expect(env.GIO_LAUNCHED_DESKTOP).toBeUndefined();
    expect(env.SOME_OTHER).toBeUndefined();
  });

  it("never logs or returns the resolved secret value — only mutates env in place", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    const result = loadFileCredentials(env, () => "super-secret-value");
    expect(result).toBeUndefined();
    for (const call of [...errorSpy.mock.calls, ...logSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain("super-secret-value");
    }
  });
});
