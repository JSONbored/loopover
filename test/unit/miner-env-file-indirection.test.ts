import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMinerFileSecrets } from "../../packages/gittensory-miner/lib/env-file-indirection.js";
import { bin } from "./support/miner-cli-harness";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadMinerFileSecrets (#5178)", () => {
  it("REGRESSION: never dereferences COMPOSE_FILE, and never calls readFile for it", () => {
    const readFile = vi.fn(() => "should never be called");
    const env: Record<string, string | undefined> = {
      COMPOSE_FILE: "docker-compose.yml:docker-compose.override.yml",
    };
    loadMinerFileSecrets(env, readFile);
    expect(env.COMPOSE).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("also excludes COMPOSE_ENV_FILE, Compose's other reserved _FILE var", () => {
    const readFile = vi.fn(() => "should never be called");
    const env: Record<string, string | undefined> = { COMPOSE_ENV_FILE: ".env.prod" };
    loadMinerFileSecrets(env, readFile);
    expect(env.COMPOSE_ENV).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("dereferences GITHUB_TOKEN_FILE into GITHUB_TOKEN, trimmed", () => {
    const readFile = vi.fn(() => "ghp_s3cr3t\n");
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    loadMinerFileSecrets(env, readFile);
    expect(readFile).toHaveBeenCalledWith("/run/secrets/github_token");
    expect(env.GITHUB_TOKEN).toBe("ghp_s3cr3t");
  });

  it("an explicit GITHUB_TOKEN always wins over GITHUB_TOKEN_FILE (documented precedence)", () => {
    const readFile = vi.fn(() => "from-file");
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN_FILE: "/run/secrets/github_token",
      GITHUB_TOKEN: "already-set",
    };
    loadMinerFileSecrets(env, readFile);
    expect(readFile).not.toHaveBeenCalled();
    expect(env.GITHUB_TOKEN).toBe("already-set");
  });

  it("ignores a key that doesn't end in _FILE, and a _FILE key with no value", () => {
    const readFile = vi.fn();
    const env: Record<string, string | undefined> = { NOT_A_SECRET: "x", EMPTY_FILE: "" };
    loadMinerFileSecrets(env, readFile);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("resolves an empty (but readable) secret file to an empty string, not an error", () => {
    const readFile = vi.fn(() => "   \n");
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    loadMinerFileSecrets(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("");
  });

  it("REGRESSION (gate divergence from the ORB analogue): throws a clear, actionable error naming the var and path when the file is missing/unreadable, instead of logging and continuing", () => {
    const readFile = vi.fn(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/missing" };
    expect(() => loadMinerFileSecrets(env, readFile)).toThrow(
      "Failed to read secret file for GITHUB_TOKEN_FILE (/run/secrets/missing): ENOENT: no such file or directory",
    );
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("formats a non-Error thrown value into the error message (defensive fallback)", () => {
    const readFile = vi.fn(() => {
      throw "boom"; // deliberately non-Error, exercising the ternary's fallback branch
    });
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/missing" };
    expect(() => loadMinerFileSecrets(env, readFile)).toThrow(
      "Failed to read secret file for GITHUB_TOKEN_FILE (/run/secrets/missing): boom",
    );
  });

  it("invariant: never includes the resolved secret's own value in a thrown error message", () => {
    const readFile = vi.fn(() => {
      throw new Error("permission denied");
    });
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    try {
      loadMinerFileSecrets(env, readFile);
      expect.unreachable("expected loadMinerFileSecrets to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("GITHUB_TOKEN_FILE");
      expect(message).toContain("/run/secrets/github_token");
      expect(message).not.toContain("ghp_");
    }
  });

  it("resolves multiple independent _FILE vars in one pass", () => {
    const contents: Record<string, string> = {
      "/run/secrets/github_token": "ghp_multi",
      "/run/secrets/anthropic_key": "sk-ant-multi",
    };
    const readFile = vi.fn((path: string) => contents[path] ?? "");
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN_FILE: "/run/secrets/github_token",
      ANTHROPIC_API_KEY_FILE: "/run/secrets/anthropic_key",
    };
    loadMinerFileSecrets(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("ghp_multi");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-multi");
  });

  it("defaults to process.env and the real node:fs reader when called with no arguments", () => {
    const original = process.env.NOT_A_REAL_MINER_SECRET_FILE;
    process.env.NOT_A_REAL_MINER_SECRET_FILE = "/definitely/does/not/exist";
    try {
      expect(() => loadMinerFileSecrets()).toThrow(/NOT_A_REAL_MINER_SECRET_FILE/);
    } finally {
      if (original === undefined) delete process.env.NOT_A_REAL_MINER_SECRET_FILE;
      else process.env.NOT_A_REAL_MINER_SECRET_FILE = original;
    }
  });

  describe("wired into the real CLI entry point (bin/loopover-miner.js)", () => {
    it("resolves GITHUB_TOKEN_FILE end-to-end: status --json reports it without ever printing the value", () => {
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-file-secret-"));
      roots.push(root);
      const secretPath = join(root, "github_token");
      writeFileSync(secretPath, "ghp_end_to_end_value\n");

      const result = spawnSync("node", [bin, "status", "--json"], {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOPOVER_MINER_CONFIG_DIR: join(root, "state"),
          GITHUB_TOKEN: "",
          GITHUB_TOKEN_FILE: secretPath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("ghp_end_to_end_value");
      expect(result.stderr).not.toContain("ghp_end_to_end_value");
    });

    it("fails the process fast with a clear error when GITHUB_TOKEN_FILE points at a missing file", () => {
      const result = spawnSync("node", [bin, "status"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_TOKEN: "",
          GITHUB_TOKEN_FILE: "/definitely/does/not/exist/github_token",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GITHUB_TOKEN_FILE");
      expect(result.stderr).toContain("/definitely/does/not/exist/github_token");
    });
  });
});
