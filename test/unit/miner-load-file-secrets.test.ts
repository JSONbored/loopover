import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINER_FILE_SECRET_VARS,
  loadMinerFileSecrets,
} from "../../packages/gittensory-miner/lib/load-file-secrets.js";

// `<NAME>_FILE` secrets-file indirection for the miner CLI (#5178). Every branch of the resolver is exercised
// here: plain-only (regression to today's behavior), `_FILE`-only, both-set precedence, neither-set, and the
// three fail-fast cases (missing/unreadable file, empty file), plus the no-secret-value-leak invariant.

/** A fake reader that records the paths it was asked to read and returns scripted contents (or throws). */
function fakeReader(contents: Record<string, string | (() => never)>) {
  const reads: string[] = [];
  const readFile = (path: string): string => {
    reads.push(path);
    const value = contents[path];
    if (typeof value === "function") return value();
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  };
  return { readFile, reads };
}

describe("loadMinerFileSecrets (#5178)", () => {
  it("exposes GITHUB_TOKEN as the only file-secret credential, frozen", () => {
    expect(MINER_FILE_SECRET_VARS).toEqual(["GITHUB_TOKEN"]);
    expect(Object.isFrozen(MINER_FILE_SECRET_VARS)).toBe(true);
  });

  it("leaves an existing plain-env-var setup untouched (no regression to today's behavior)", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN: "plain-token" };
    const { readFile, reads } = fakeReader({});
    loadMinerFileSecrets(env, { readFile });
    expect(env.GITHUB_TOKEN).toBe("plain-token");
    expect(reads).toEqual([]); // no `_FILE` set -> the reader is never consulted
  });

  it("resolves GITHUB_TOKEN from GITHUB_TOKEN_FILE, trimming trailing whitespace/newlines", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    const { readFile, reads } = fakeReader({ "/run/secrets/github_token": "  file-token\n\n" });
    loadMinerFileSecrets(env, { readFile });
    expect(env.GITHUB_TOKEN).toBe("file-token");
    expect(reads).toEqual(["/run/secrets/github_token"]);
  });

  it("lets an explicit plain GITHUB_TOKEN win over GITHUB_TOKEN_FILE and never reads the file", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "plain-wins",
      GITHUB_TOKEN_FILE: "/run/secrets/github_token",
    };
    const { readFile, reads } = fakeReader({ "/run/secrets/github_token": "file-loses" });
    loadMinerFileSecrets(env, { readFile });
    expect(env.GITHUB_TOKEN).toBe("plain-wins");
    expect(reads).toEqual([]); // precedence short-circuits the read entirely
  });

  it("does nothing when neither the plain var nor its _FILE companion is set", () => {
    const env: Record<string, string | undefined> = { UNRELATED: "x" };
    const { readFile, reads } = fakeReader({});
    loadMinerFileSecrets(env, { readFile });
    expect(env).toEqual({ UNRELATED: "x" });
    expect(reads).toEqual([]);
  });

  it("fails fast with the variable and path (never the secret value) when the file is missing/unreadable", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/missing" };
    const { readFile } = fakeReader({});
    expect(() => loadMinerFileSecrets(env, { readFile })).toThrow(
      "miner_secret_file_unreadable:GITHUB_TOKEN_FILE:/run/secrets/missing",
    );
    expect(env.GITHUB_TOKEN).toBeUndefined(); // never silently falls through to an empty credential
  });

  it("fails fast when the file exists but is empty/whitespace-only", () => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/empty" };
    const { readFile } = fakeReader({ "/run/secrets/empty": "   \n\t " });
    expect(() => loadMinerFileSecrets(env, { readFile })).toThrow(
      "miner_secret_file_empty:GITHUB_TOKEN_FILE:/run/secrets/empty",
    );
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("invariant: never logs anything, and a thrown error never contains the file contents (secret value)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "ghp_supersecretvalue1234567890";
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    // A reader that returns the secret then a second env whose file throws with the secret in the message.
    loadMinerFileSecrets(env, { readFile: () => `${secret}\n` });
    expect(env.GITHUB_TOKEN).toBe(secret); // resolved value is used...
    expect(errorSpy).not.toHaveBeenCalled(); // ...but nothing is ever logged
    expect(logSpy).not.toHaveBeenCalled();

    const failing: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    let message = "";
    try {
      loadMinerFileSecrets(failing, {
        readFile: () => {
          throw new Error(`open failed while holding ${secret}`);
        },
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("miner_secret_file_unreadable");
    expect(message).not.toContain(secret); // the underlying cause is attached, not inlined into the message
  });

  it("honors a custom credential allowlist (the single extension point if more credentials become env vars)", () => {
    const env: Record<string, string | undefined> = { FORGE_TOKEN_FILE: "/run/secrets/forge" };
    const { readFile } = fakeReader({ "/run/secrets/forge": "forge-token\n" });
    loadMinerFileSecrets(env, { readFile, vars: ["FORGE_TOKEN"] });
    expect(env.FORGE_TOKEN).toBe("forge-token");
  });

  it("uses the real filesystem reader and the default GITHUB_TOKEN allowlist when neither is injected", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-miner-secret-"));
    const path = join(dir, "github_token");
    writeFileSync(path, "real-fs-token\n");
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: path };
    loadMinerFileSecrets(env); // no options -> default readFileSync + default MINER_FILE_SECRET_VARS
    expect(env.GITHUB_TOKEN).toBe("real-fs-token");
  });

  describe("default env argument", () => {
    const saved = { token: process.env.GITHUB_TOKEN, file: process.env.GITHUB_TOKEN_FILE };
    afterEach(() => {
      if (saved.token === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved.token;
      if (saved.file === undefined) delete process.env.GITHUB_TOKEN_FILE;
      else process.env.GITHUB_TOKEN_FILE = saved.file;
    });

    it("defaults to process.env when called with no arguments", () => {
      const dir = mkdtempSync(join(tmpdir(), "gt-miner-procenv-"));
      const path = join(dir, "github_token");
      writeFileSync(path, "proc-env-token\n");
      delete process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN_FILE = path;
      loadMinerFileSecrets();
      expect(process.env.GITHUB_TOKEN).toBe("proc-env-token");
    });
  });
});
