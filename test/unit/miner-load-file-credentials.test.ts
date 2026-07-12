import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  loadMinerFileCredentials,
  MINER_CREDENTIAL_ENV_VARS,
} from "../../packages/gittensory-miner/lib/load-file-credentials.js";

describe("loadMinerFileCredentials (#5178)", () => {
  it("resolves exactly the GitHub token and the coding-agent provider credentials", () => {
    expect(MINER_CREDENTIAL_ENV_VARS).toEqual(["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  it("plain var only: leaves an inline credential untouched and never reads a file", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => "unused");
    const env: Record<string, string | undefined> = { GITHUB_TOKEN: "inline-tok" };
    loadMinerFileCredentials(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("inline-tok");
    expect(readFile).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("_FILE only: reads the file, trims trailing whitespace, and populates the credential", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => "file-tok\n");
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/github_token" };
    loadMinerFileCredentials(env, readFile);
    expect(readFile).toHaveBeenCalledWith("/run/secrets/github_token");
    expect(env.GITHUB_TOKEN).toBe("file-tok"); // trimmed
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: "info", event: "miner_credential_source", var: "GITHUB_TOKEN", source: "file" }),
    );
    errorSpy.mockRestore();
  });

  it("both set: the explicit inline value wins over the _FILE companion (documented precedence)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => "from-file");
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "inline-wins",
      GITHUB_TOKEN_FILE: "/run/secrets/github_token",
    };
    loadMinerFileCredentials(env, readFile);
    expect(env.GITHUB_TOKEN).toBe("inline-wins");
    expect(readFile).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: "info", event: "miner_credential_source", var: "GITHUB_TOKEN", source: "env" }),
    );
    errorSpy.mockRestore();
  });

  it("neither set: is a no-op that reads nothing and logs nothing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => "unused");
    const env: Record<string, string | undefined> = {};
    loadMinerFileCredentials(env, readFile);
    expect(readFile).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    errorSpy.mockRestore();
  });

  it("_FILE unreadable/missing: throws an actionable error naming the file path, never falling through", () => {
    const readFile = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/missing" };
    expect(() => loadMinerFileCredentials(env, readFile)).toThrow(
      /GITHUB_TOKEN_FILE.*\/run\/secrets\/missing.*missing or unreadable/,
    );
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("_FILE empty: throws rather than resolving to an empty credential", () => {
    const readFile = vi.fn(() => "   \n");
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY_FILE: "/run/secrets/anthropic" };
    expect(() => loadMinerFileCredentials(env, readFile)).toThrow(/ANTHROPIC_API_KEY_FILE.*empty/);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("applies to every coding-agent provider credential, not just GITHUB_TOKEN", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn((path: string) => (path.includes("anthropic") ? "anthropic-key\n" : "openai-key\n"));
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY_FILE: "/run/secrets/anthropic",
      OPENAI_API_KEY_FILE: "/run/secrets/openai",
    };
    loadMinerFileCredentials(env, readFile);
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    errorSpy.mockRestore();
  });

  it("INVARIANT: never logs or returns the raw secret value -- only its source", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "sup3r-s3cret-file-value";
    const readFile = vi.fn(() => secret);
    const env: Record<string, string | undefined> = { OPENAI_API_KEY_FILE: "/run/secrets/openai" };
    const returned = loadMinerFileCredentials(env, readFile);
    expect(returned).toBeUndefined(); // returns nothing at all
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).not.toContain(secret);
    }
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: "info", event: "miner_credential_source", var: "OPENAI_API_KEY", source: "file" }),
    );
    expect(env.OPENAI_API_KEY).toBe(secret);
    errorSpy.mockRestore();
  });

  it("REGRESSION: an operator's existing plain-env-var setup keeps working unchanged (no _FILE anywhere)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => "unused");
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "gh-plain",
      ANTHROPIC_API_KEY: "an-plain",
      OPENAI_API_KEY: "oa-plain",
    };
    loadMinerFileCredentials(env, readFile);
    expect(env).toEqual({ GITHUB_TOKEN: "gh-plain", ANTHROPIC_API_KEY: "an-plain", OPENAI_API_KEY: "oa-plain" });
    expect(readFile).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("defaults to process.env and the real node:fs reader when called with no arguments", () => {
    const credVars = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
    const allVars = [...credVars, ...credVars.map((name) => `${name}_FILE`)];
    const saved: Record<string, string | undefined> = {};
    for (const key of allVars) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    const tmp = mkdtempSync(join(tmpdir(), "miner-file-secrets-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const file = join(tmp, "github_token");
      writeFileSync(file, "real-file-tok\n");
      process.env.GITHUB_TOKEN_FILE = file;
      loadMinerFileCredentials();
      expect(process.env.GITHUB_TOKEN).toBe("real-file-tok");
    } finally {
      errorSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
      for (const key of allVars) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
