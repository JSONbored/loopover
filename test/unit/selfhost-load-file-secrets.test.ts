import { describe, expect, it, vi } from "vitest";
import { loadFileSecrets } from "../../src/selfhost/load-file-secrets";

describe("loadFileSecrets (#4403)", () => {
  it("REGRESSION: never dereferences COMPOSE_FILE, and logs no false error for it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => "should never be called");
    const env: Record<string, string | undefined> = {
      COMPOSE_FILE: "docker-compose.yml:docker-compose.override.yml:docker-compose.local-gpu.yml",
    };
    loadFileSecrets(env, readFile);
    expect(env.COMPOSE).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("also excludes COMPOSE_ENV_FILE, Compose's other reserved _FILE var", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => "should never be called");
    const env: Record<string, string | undefined> = { COMPOSE_ENV_FILE: ".env.prod" };
    loadFileSecrets(env, readFile);
    expect(env.COMPOSE_ENV).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("dereferences a real gittensory secret _FILE var into its target name", () => {
    const readFile = vi.fn(() => "s3cr3t-value\n");
    const env: Record<string, string | undefined> = { SENTRY_DSN_FILE: "/run/secrets/sentry_dsn" };
    loadFileSecrets(env, readFile);
    expect(readFile).toHaveBeenCalledWith("/run/secrets/sentry_dsn");
    expect(env.SENTRY_DSN).toBe("s3cr3t-value"); // trimmed
  });

  it("does not overwrite an already-set explicit value", () => {
    const readFile = vi.fn(() => "from-file");
    const env: Record<string, string | undefined> = { SENTRY_DSN_FILE: "/run/secrets/sentry_dsn", SENTRY_DSN: "already-set" };
    loadFileSecrets(env, readFile);
    expect(readFile).not.toHaveBeenCalled();
    expect(env.SENTRY_DSN).toBe("already-set");
  });

  it("ignores a key that doesn't end in _FILE, and a _FILE key with no value", () => {
    const readFile = vi.fn();
    const env: Record<string, string | undefined> = { NOT_A_SECRET: "x", EMPTY_FILE: "" };
    loadFileSecrets(env, readFile);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("logs a structured error and leaves the target unset when the file read fails, for a genuine secret var", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const env: Record<string, string | undefined> = { SENTRY_DSN_FILE: "/run/secrets/missing" };
    loadFileSecrets(env, readFile);
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: "error", event: "selfhost_secret_file_unreadable", var: "SENTRY_DSN_FILE" }),
    );
    errorSpy.mockRestore();
  });

  it("defaults to process.env and the real node:fs reader when called with no arguments", () => {
    const original = process.env.NOT_A_REAL_SECRET_FILE;
    process.env.NOT_A_REAL_SECRET_FILE = "/definitely/does/not/exist";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadFileSecrets();
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: "error", event: "selfhost_secret_file_unreadable", var: "NOT_A_REAL_SECRET_FILE" }),
    );
    errorSpy.mockRestore();
    if (original === undefined) delete process.env.NOT_A_REAL_SECRET_FILE;
    else process.env.NOT_A_REAL_SECRET_FILE = original;
  });
});
