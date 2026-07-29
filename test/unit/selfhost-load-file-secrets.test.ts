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

  it("dereferences a real loopover secret _FILE var into its target name", () => {
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

  it("REGRESSION (#6284): throws (and logs) when a configured _FILE secret is missing/unreadable, instead of leaving the target unset", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const env: Record<string, string | undefined> = { SENTRY_DSN_FILE: "/run/secrets/missing" };
    expect(() => loadFileSecrets(env, readFile)).toThrow(
      "Failed to read secret file for SENTRY_DSN_FILE (/run/secrets/missing): ENOENT",
    );
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: "error", event: "selfhost_secret_file_unreadable", var: "SENTRY_DSN_FILE" }),
    );
    errorSpy.mockRestore();
  });

  it("formats a non-Error thrown value into the fail-fast error message", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readFile = vi.fn(() => {
      throw "boom";
    });
    const env: Record<string, string | undefined> = { TOKEN_ENCRYPTION_SECRET_FILE: "/run/secrets/missing" };
    expect(() => loadFileSecrets(env, readFile)).toThrow(
      "Failed to read secret file for TOKEN_ENCRYPTION_SECRET_FILE (/run/secrets/missing): boom",
    );
    expect(env.TOKEN_ENCRYPTION_SECRET).toBeUndefined();
    errorSpy.mockRestore();
  });

  it("still starts normally when no _FILE secret is configured at all", () => {
    const readFile = vi.fn(() => {
      throw new Error("should never be called");
    });
    const env: Record<string, string | undefined> = { SENTRY_DSN: "already-set-inline" };
    expect(() => loadFileSecrets(env, readFile)).not.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(env.SENTRY_DSN).toBe("already-set-inline");
  });

  it("defaults to process.env and the real node:fs reader when called with no arguments", () => {
    const original = process.env.NOT_A_REAL_SECRET_FILE;
    process.env.NOT_A_REAL_SECRET_FILE = "/definitely/does/not/exist";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => loadFileSecrets()).toThrow(/NOT_A_REAL_SECRET_FILE/);
      expect(errorSpy).toHaveBeenCalledWith(
        JSON.stringify({ level: "error", event: "selfhost_secret_file_unreadable", var: "NOT_A_REAL_SECRET_FILE" }),
      );
    } finally {
      errorSpy.mockRestore();
      if (original === undefined) delete process.env.NOT_A_REAL_SECRET_FILE;
      else process.env.NOT_A_REAL_SECRET_FILE = original;
    }
  });
});

// #9487: a missing/unreadable secret file correctly throws (#6284), but a zero-byte or whitespace-only one
// set `env[NAME] = ""` — which every downstream `nonBlank()` reads as UNCONFIGURED, and preflight.ts
// deliberately skips absent values. So a truncated GITHUB_WEBHOOK_SECRET file booted an instance that
// rejected every webhook, healthily, forever. Directly adjacent to the known rotation footgun on edge-nl-01,
// where the file is rewritten in place: the window in which it is momentarily empty is exactly when a
// container restart reads it.
describe("empty secret files are fatal, not silently unconfigured (#9487)", () => {
  it.each([
    ["zero-byte", ""],
    ["whitespace-only", "   \n\t  "],
  ])("REGRESSION: a %s secret file throws instead of setting an empty value", (_label, contents) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env: Record<string, string | undefined> = { GITHUB_WEBHOOK_SECRET_FILE: "/run/secrets/webhook" };

    expect(() => loadFileSecrets(env, () => contents)).toThrow(/empty/i);
    // The decisive assertion: the target must be left UNSET, never "" — an empty string is precisely the
    // value that reads as "not configured" downstream while looking like a successful load here.
    expect(env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("selfhost_secret_file_empty"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("INVARIANT: the empty and unreadable failures stay DISTINCT — an operator must know which problem they have", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unreadable: Record<string, string | undefined> = { A_SECRET_FILE: "/nope" };
    expect(() =>
      loadFileSecrets(unreadable, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/Failed to read secret file/);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("selfhost_secret_file_unreadable"))).toBe(true);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("selfhost_secret_file_empty"))).toBe(false);
    errorSpy.mockRestore();
  });

  it("INVARIANT: a secret file with surrounding whitespace still loads, trimmed — only a FULLY empty one is fatal", () => {
    const env: Record<string, string | undefined> = { A_SECRET_FILE: "/run/secrets/a" };
    loadFileSecrets(env, () => "  real-value\n");
    expect(env.A_SECRET).toBe("real-value");
  });

  it("INVARIANT: an explicit env value still wins and the file is never read, empty or not", () => {
    const readFile = vi.fn(() => "");
    const env: Record<string, string | undefined> = { A_SECRET: "explicit", A_SECRET_FILE: "/run/secrets/a" };
    loadFileSecrets(env, readFile);
    expect(env.A_SECRET).toBe("explicit");
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("loadFileSecrets return value (#9543 — which vars actually came from a file)", () => {
  it("returns only the vars it materialised from a file", () => {
    const env: Record<string, string | undefined> = {
      FROM_FILE_FILE: "/secrets/a",
      ALREADY_SET: "inline-value",
      ALREADY_SET_FILE: "/secrets/b",
      PLAIN: "not-a-file-var",
    };
    const names = loadFileSecrets(env, (path) => (path === "/secrets/a" ? "  file-value\n" : "unused"));
    // ALREADY_SET is excluded because an inline value wins -- that exclusion is the whole point: a
    // call-time re-read must not swap an inline operator's credential (secrets/README.md).
    expect(names).toEqual(["FROM_FILE"]);
    expect(env.FROM_FILE).toBe("file-value");
    expect(env.ALREADY_SET).toBe("inline-value");
  });

  it("returns an empty list when nothing is file-sourced", () => {
    expect(loadFileSecrets({ PLAIN: "x" }, () => "unused")).toEqual([]);
  });

  it("excludes Compose's own reserved _FILE vars", () => {
    const env: Record<string, string | undefined> = { COMPOSE_FILE: "a.yml:b.yml", COMPOSE_ENV_FILE: "/custom/.env" };
    expect(loadFileSecrets(env, () => "unused")).toEqual([]);
  });
});

describe("empty placeholders for externally-issued secrets (#9487 follow-up)", () => {
  // scripts/selfhost-init-secrets.sh creates a ZERO-BYTE placeholder for the four secrets it cannot
  // generate, and compose refuses to start unless the file exists. #9487 then made an empty file fatal, so
  // running the documented setup and starting the container crash-looped it. Observed live on the ORB: an
  // unused GitHub App key took the whole instance down on upgrade.
  const EXTERNALLY_ISSUED = [
    "GITHUB_APP_PRIVATE_KEY_FILE",
    "ORB_ENROLLMENT_SECRET_FILE",
    "PAGERDUTY_ROUTING_KEY_FILE",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE",
  ];

  it.each(EXTERNALLY_ISSUED)("REGRESSION: an empty %s is skipped, not fatal", (key) => {
    const env: Record<string, string | undefined> = { [key]: "/run/secrets/placeholder" };
    expect(() => loadFileSecrets(env, () => "")).not.toThrow();
    // Left genuinely UNSET rather than set to "" -- the pre-#9487 bug was an empty string that read as
    // configured-but-blank to anything checking presence rather than truthiness.
    expect(env[key.slice(0, -"_FILE".length)]).toBeUndefined();
  });

  it("REGRESSION: reproduces the exact ORB boot crash and shows it is fixed", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/github_app_private_key",
      GITHUB_WEBHOOK_SECRET_FILE: "/run/secrets/github_webhook_secret",
    };
    const files: Record<string, string> = {
      "/run/secrets/github_app_private_key": "",
      "/run/secrets/github_webhook_secret": "a-real-webhook-secret",
    };
    expect(() => loadFileSecrets(env, (path) => files[path] ?? "")).not.toThrow();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.GITHUB_WEBHOOK_SECRET).toBe("a-real-webhook-secret");
  });

  it("INVARIANT: #9487's fail-closed behavior is UNCHANGED for a self-generated secret", () => {
    // The bug #9487 actually fixed: a truncated webhook secret booting an instance that silently rejected
    // every webhook. The init script writes a real random value here, so empty can only mean truncation.
    const env: Record<string, string | undefined> = { GITHUB_WEBHOOK_SECRET_FILE: "/run/secrets/github_webhook_secret" };
    expect(() => loadFileSecrets(env, () => "")).toThrow(/is empty/);
  });

  it("whitespace-only is treated the same as empty for an optional secret", () => {
    const env: Record<string, string | undefined> = { PAGERDUTY_ROUTING_KEY_FILE: "/run/secrets/pagerduty_routing_key" };
    expect(() => loadFileSecrets(env, () => "  \n\t ")).not.toThrow();
    expect(env.PAGERDUTY_ROUTING_KEY).toBeUndefined();
  });

  it("a REAL value in an optional secret still loads normally", () => {
    const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN_FILE: "/run/secrets/claude_code_oauth_token" };
    expect(loadFileSecrets(env, () => "  real-token  ")).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("real-token");
  });

  it("an UNREADABLE optional secret is still fatal — missing is not the same as deliberately empty", () => {
    const env: Record<string, string | undefined> = { GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/gone" };
    expect(() => loadFileSecrets(env, () => { throw new Error("ENOENT"); })).toThrow(/Failed to read secret file/);
  });
});
