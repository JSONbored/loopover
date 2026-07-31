import { generateKeyPairSync } from "node:crypto";

import {
  assertSelfHostPreflight,
  formatSelfHostPreflightError,
  preflightEnv,
  type SelfHostPreflightProblem,
} from "../../src/selfhost/preflight";

describe("self-host environment preflight (#2080)", () => {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  it("returns every missing required value at once for the first-run setup path", () => {
    const result = preflightEnv({});

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ var: "REDIS_URL" }),
        expect.objectContaining({ var: "SELFHOST_SETUP_TOKEN" }),
        expect.objectContaining({ var: "PUBLIC_API_ORIGIN" }),
      ],
    });
  });

  it("trims values, passes configured GitHub App installs, and accepts postgres URLs", () => {
    expect(
      preflightEnv({
        REDIS_URL: " redis://redis:6379 ",
        GITHUB_APP_ID: " 123 ",
        GITHUB_APP_PRIVATE_KEY: ` ${privateKey} `,
        DATABASE_URL: " postgres://loopover:secret@postgres:5432/loopover ",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        DATABASE_URL: "postgresql://loopover:secret@postgres:5432/loopover",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        DATABASE_URL: "postgresql:///loopover?host=/var/run/postgresql",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "rediss://redis.example:6380",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
      }),
    ).toEqual({ ok: true, problems: [] });
  });

  it("requires setup-wizard vars only when neither a GitHub App nor Orb broker enrollment is configured", () => {
    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        SELFHOST_SETUP_TOKEN: "setup-secret-with-enough-entropy-1",
        PUBLIC_API_ORIGIN: "https://selfhost.example",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        ORB_ENROLLMENT_SECRET: "orb-secret",
      }),
    ).toEqual({ ok: true, problems: [] });
  });

  it("requires PUBLIC_API_ORIGIN to be a parseable bare HTTPS origin", () => {
    for (const PUBLIC_API_ORIGIN of [
      "not-a-url",
      "http://selfhost.example",
      "https://selfhost.example/setup",
      "https://user:password@selfhost.example",
    ]) {
      const result = preflightEnv({
        REDIS_URL: "redis://redis:6379",
        SELFHOST_SETUP_TOKEN: "setup-secret-with-enough-entropy-1",
        PUBLIC_API_ORIGIN,
      });

      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "PUBLIC_API_ORIGIN" })],
      });
      expect(JSON.stringify(result)).not.toContain(PUBLIC_API_ORIGIN);
    }
  });

  it("requires Redis to be a parseable redis URL", () => {
    for (const REDIS_URL of [
      "redis",
      "http://:redis-password@redis:6379",
      "redis://",
    ]) {
      const result = preflightEnv({
        REDIS_URL,
        SELFHOST_SETUP_TOKEN: "setup-secret-with-enough-entropy-1",
        PUBLIC_API_ORIGIN: "https://selfhost.example",
      });

      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "REDIS_URL" })],
      });
      expect(JSON.stringify(result)).not.toContain("redis-password");
    }
  });

  it("requires the complete GitHub App credential pair before bypassing setup", () => {
    const missingPrivateKey = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "123",
    });

    expect(missingPrivateKey).toEqual({
      ok: false,
      problems: [expect.objectContaining({ var: "GITHUB_APP_PRIVATE_KEY" })],
    });

    const missingAppId = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_PRIVATE_KEY: privateKey,
    });

    expect(missingAppId).toEqual({
      ok: false,
      problems: [expect.objectContaining({ var: "GITHUB_APP_ID" })],
    });
    expect(JSON.stringify(missingAppId)).not.toContain(privateKey.slice(0, 24));
  });

  it("requires parseable GitHub App credentials when setup is bypassed", () => {
    const result = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "not-a-number",
      GITHUB_APP_PRIVATE_KEY: "not-a-pem-private-key",
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ var: "GITHUB_APP_ID" }),
        expect.objectContaining({ var: "GITHUB_APP_PRIVATE_KEY" }),
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("not-a-number");
    expect(serialized).not.toContain("not-a-pem-private-key");

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "\\n",
      }),
    ).toEqual({
      ok: false,
      problems: [expect.objectContaining({ var: "GITHUB_APP_PRIVATE_KEY" })],
    });
  });

  it("requires DATABASE_URL to parse as a usable postgres DSN", () => {
    for (const DATABASE_URL of [
      "postgres://",
      "postgres://postgres",
      "postgresql:///loopover",
      "sqlite:///tmp/loopover.sqlite?password=super-secret-db",
    ]) {
      const result = preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        DATABASE_URL,
      });

      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "DATABASE_URL" })],
      });
    }

    const secretBearing = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      DATABASE_URL: "postgres://user:super-secret-db@/loopover",
    });
    expect(JSON.stringify(secretBearing)).not.toContain("super-secret-db");
  });

  describe("critical secrets (Codex security finding: shipped placeholder tokens)", () => {
    const baseEnv = {
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey,
    };

    it("rejects each critical secret when it is still the exact placeholder shipped in .env.selfhost.example / .env.example", () => {
      for (const [name, placeholder] of [
        ["GITHUB_WEBHOOK_SECRET", "change-this-long-random-value"],
        ["LOOPOVER_API_TOKEN", "change-this-32-byte-random-token"],
        ["LOOPOVER_MCP_TOKEN", "change-this-32-byte-random-token"],
        ["INTERNAL_JOB_TOKEN", "change-this-32-byte-random-token"],
        ["SELFHOST_SETUP_TOKEN", "change-this-long-random-value"],
      ] as const) {
        const result = preflightEnv({ ...baseEnv, [name]: placeholder });
        expect(result.ok).toBe(false);
        expect(result).toEqual({
          ok: false,
          problems: [expect.objectContaining({ var: name })],
        });
        if (!result.ok) expect(JSON.stringify(result.problems)).not.toContain(placeholder);
      }
    });

    it("rejects a critical secret that is non-blank but shorter than the minimum safe length", () => {
      const result = preflightEnv({ ...baseEnv, GITHUB_WEBHOOK_SECRET: "weakvalue123" });
      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "GITHUB_WEBHOOK_SECRET", message: expect.stringContaining("too short") })],
      });
      expect(JSON.stringify(result)).not.toContain("weakvalue123");
    });

    it("accepts a critical secret at exactly the minimum length, and one character below it still fails", () => {
      const exactly20 = "a".repeat(20);
      expect(preflightEnv({ ...baseEnv, GITHUB_WEBHOOK_SECRET: exactly20 })).toEqual({ ok: true, problems: [] });

      const nineteen = "a".repeat(19);
      const result = preflightEnv({ ...baseEnv, GITHUB_WEBHOOK_SECRET: nineteen });
      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "GITHUB_WEBHOOK_SECRET" })],
      });
    });

    it("does not require any critical secret to be present — only judges strength when one is set", () => {
      expect(preflightEnv(baseEnv)).toEqual({ ok: true, problems: [] });
    });

    it("rejects two critical secrets that reuse the identical value, without echoing it", () => {
      const sharedSecret = "a-perfectly-strong-random-value-1234";
      const result = preflightEnv({
        ...baseEnv,
        LOOPOVER_API_TOKEN: sharedSecret,
        LOOPOVER_MCP_TOKEN: sharedSecret,
      });
      expect(result).toEqual({
        ok: false,
        problems: [
          expect.objectContaining({
            var: "LOOPOVER_MCP_TOKEN",
            message: expect.stringContaining("must not reuse the same value as LOOPOVER_API_TOKEN"),
          }),
        ],
      });
      expect(JSON.stringify(result)).not.toContain(sharedSecret);
    });

    it("accepts every critical secret when each is a distinct, sufficiently long real value", () => {
      expect(
        preflightEnv({
          ...baseEnv,
          GITHUB_WEBHOOK_SECRET: "webhook-secret-value-with-plenty-of-entropy",
          LOOPOVER_API_TOKEN: "api-token-value-with-plenty-of-entropy-2",
          LOOPOVER_MCP_TOKEN: "mcp-token-value-with-plenty-of-entropy-3",
          INTERNAL_JOB_TOKEN: "internal-job-token-with-plenty-of-entropy-4",
          SELFHOST_SETUP_TOKEN: "setup-token-value-with-plenty-of-entropy-5",
        }),
      ).toEqual({ ok: true, problems: [] });
    });

    it("collects a placeholder/weak-secret problem for EVERY affected critical secret, not just the first", () => {
      const result = preflightEnv({
        ...baseEnv,
        GITHUB_WEBHOOK_SECRET: "change-this-long-random-value",
        LOOPOVER_API_TOKEN: "change-this-32-byte-random-token",
      });
      expect(result).toEqual({
        ok: false,
        problems: [
          expect.objectContaining({ var: "GITHUB_WEBHOOK_SECRET" }),
          expect.objectContaining({ var: "LOOPOVER_API_TOKEN" }),
        ],
      });
    });
  });

  it("flags blank values and invalid DATABASE_URL while never echoing supplied secrets", () => {
    const result = preflightEnv({
      REDIS_URL: "   ",
      SELFHOST_SETUP_TOKEN: "secret-setup-token-with-enough-entropy",
      PUBLIC_API_ORIGIN: "https://selfhost.example",
      DATABASE_URL: "sqlite:///tmp/loopover.sqlite?password=super-secret-db",
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ var: "REDIS_URL" }),
        expect.objectContaining({ var: "DATABASE_URL" }),
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-setup-token-with-enough-entropy");
    expect(serialized).not.toContain("super-secret-db");
    expect(serialized).not.toContain("sqlite:///tmp");
  });

  it("formats all problems with names and actionable hints", () => {
    const problems: SelfHostPreflightProblem[] = [
      { var: "REDIS_URL", message: "Set REDIS_URL to Redis." },
      { var: "PUBLIC_API_ORIGIN", message: "Set PUBLIC_API_ORIGIN to HTTPS." },
    ];

    expect(formatSelfHostPreflightError(problems)).toBe(
      "Self-host environment preflight failed:\n" +
        "- REDIS_URL: Set REDIS_URL to Redis.\n" +
        "- PUBLIC_API_ORIGIN: Set PUBLIC_API_ORIGIN to HTTPS.",
    );
  });

  describe("numeric env knobs (#9157: a malformed value must fail boot, not silently NaN into a runaway/disabled feature)", () => {
    const baseEnv = {
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey,
    };

    it("accepts every knob when unset — presence is never required, only format when set", () => {
      expect(preflightEnv(baseEnv)).toEqual({ ok: true, problems: [] });
    });

    it("accepts valid values for CRON_INTERVAL_MS, PORT, and GITHUB_CACHE_TTL_SECONDS", () => {
      expect(
        preflightEnv({ ...baseEnv, CRON_INTERVAL_MS: "120000", PORT: "8787", GITHUB_CACHE_TTL_SECONDS: "20" }),
      ).toEqual({ ok: true, problems: [] });
    });

    it("accepts GITHUB_CACHE_TTL_SECONDS=0 (the documented 'disable the cache' value)", () => {
      expect(preflightEnv({ ...baseEnv, GITHUB_CACHE_TTL_SECONDS: "0" })).toEqual({ ok: true, problems: [] });
    });

    it("rejects a malformed LOOPOVER_SHUTDOWN_LOCK_RELEASE_AFTER_MS instead of only warning at use time (#10056)", () => {
      for (const LOOPOVER_SHUTDOWN_LOCK_RELEASE_AFTER_MS of ["30s", "30_000", "0.5", "-1"]) {
        expect(preflightEnv({ ...baseEnv, LOOPOVER_SHUTDOWN_LOCK_RELEASE_AFTER_MS })).toEqual({
          ok: false,
          problems: [expect.objectContaining({ var: "LOOPOVER_SHUTDOWN_LOCK_RELEASE_AFTER_MS" })],
        });
      }
    });

    it("accepts unset / '' / '0' (wait-for-the-drain default) / a plain integer for LOOPOVER_SHUTDOWN_LOCK_RELEASE_AFTER_MS (#10056)", () => {
      for (const value of [undefined, "", "0", "30000"]) {
        const env = value === undefined ? { ...baseEnv } : { ...baseEnv, LOOPOVER_SHUTDOWN_LOCK_RELEASE_AFTER_MS: value };
        expect(preflightEnv(env)).toEqual({ ok: true, problems: [] });
      }
    });

    it("rejects a malformed OLLAMA_NUM_CTX, and additionally rejects '0' (not a meaningful context window) (#10056)", () => {
      for (const OLLAMA_NUM_CTX of ["30s", "30_000", "0.5", "-1", "0"]) {
        expect(preflightEnv({ ...baseEnv, OLLAMA_NUM_CTX })).toEqual({
          ok: false,
          problems: [expect.objectContaining({ var: "OLLAMA_NUM_CTX" })],
        });
      }
    });

    it("accepts unset / '' / '1' / a plain integer for OLLAMA_NUM_CTX (#10056)", () => {
      for (const value of [undefined, "", "1", "65536"]) {
        const env = value === undefined ? { ...baseEnv } : { ...baseEnv, OLLAMA_NUM_CTX: value };
        expect(preflightEnv(env)).toEqual({ ok: true, problems: [] });
      }
    });

    it("rejects a unit-suffixed or separator-formatted value instead of silently NaN-ing", () => {
      for (const CRON_INTERVAL_MS of ["2m", "120s", "120_000", "12.5", "-5", "abc"]) {
        const result = preflightEnv({ ...baseEnv, CRON_INTERVAL_MS });
        expect(result).toEqual({
          ok: false,
          problems: [expect.objectContaining({ var: "CRON_INTERVAL_MS" })],
        });
      }
    });

    it("rejects CRON_INTERVAL_MS=0 — NOT a supported 'disable the cron' value, unlike GITHUB_CACHE_TTL_SECONDS", () => {
      expect(preflightEnv({ ...baseEnv, CRON_INTERVAL_MS: "0" })).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "CRON_INTERVAL_MS" })],
      });
    });

    it("rejects CRON_INTERVAL_MS below the floor and above the ceiling", () => {
      expect(preflightEnv({ ...baseEnv, CRON_INTERVAL_MS: "9999" })).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "CRON_INTERVAL_MS" })],
      });
      expect(preflightEnv({ ...baseEnv, CRON_INTERVAL_MS: String(24 * 60 * 60_000 + 1) })).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "CRON_INTERVAL_MS" })],
      });
    });

    it("rejects PORT of 0 or above 65535", () => {
      expect(preflightEnv({ ...baseEnv, PORT: "0" })).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "PORT" })],
      });
      expect(preflightEnv({ ...baseEnv, PORT: "65536" })).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "PORT" })],
      });
    });

    it("rejects a negative GITHUB_CACHE_TTL_SECONDS and one above its ceiling", () => {
      expect(preflightEnv({ ...baseEnv, GITHUB_CACHE_TTL_SECONDS: "-1" })).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "GITHUB_CACHE_TTL_SECONDS" })],
      });
      expect(preflightEnv({ ...baseEnv, GITHUB_CACHE_TTL_SECONDS: "86401" })).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "GITHUB_CACHE_TTL_SECONDS" })],
      });
    });

    it("rejects a digit string so large it overflows to a non-finite number despite matching the digit-only regex", () => {
      const result = preflightEnv({ ...baseEnv, PORT: "9".repeat(400) });
      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "PORT" })],
      });
    });

    it("collects a problem for every affected numeric knob at once, not just the first", () => {
      const result = preflightEnv({ ...baseEnv, CRON_INTERVAL_MS: "2m", PORT: "not-a-port", GITHUB_CACHE_TTL_SECONDS: "-1" });
      expect(result).toEqual({
        ok: false,
        problems: [
          expect.objectContaining({ var: "CRON_INTERVAL_MS" }),
          expect.objectContaining({ var: "PORT" }),
          expect.objectContaining({ var: "GITHUB_CACHE_TTL_SECONDS" }),
        ],
      });
    });
  });

  it("asserts the preflight result for the boot path", () => {
    expect(() =>
      assertSelfHostPreflight({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }),
    ).not.toThrow();

    expect(() => assertSelfHostPreflight({ DATABASE_URL: "mysql://db/app" })).toThrow(
      /Self-host environment preflight failed:\n- REDIS_URL: .*SELFHOST_SETUP_TOKEN.*PUBLIC_API_ORIGIN.*DATABASE_URL:/s,
    );
  });
});

describe("ledger-anchor configuration preflight (#9769)", () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const base = { REDIS_URL: "redis://redis:6379", GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey };
  const key = (over: Record<string, unknown> = {}) => JSON.stringify([{ keyId: "k1", publicKeySpki: "c3BraQ==", notBefore: "2026-01-01T00:00:00.000Z", notAfter: null, ...over }]);
  const anchorProblems = (env: Record<string, string | undefined>) => {
    const result = preflightEnv({ ...base, ...env });
    return result.problems.filter((p: SelfHostPreflightProblem) => p.var.startsWith("LOOPOVER_LEDGER_ANCHOR"));
  };

  // #9850: a malformed waiver fails CLOSED -- safe, but silent. The operator believes rows are declared when
  // they are not, and finds out only when the public endpoint keeps failing on mismatches they thought they
  // had disclosed. Same class as the half-configured anchoring below: the danger is the set-but-ineffective
  // value, not the unset one.
  const waiverProblems = (env: Record<string, string | undefined>) =>
    preflightEnv({ ...base, ...env }).problems.filter((p: SelfHostPreflightProblem) => p.var === "LOOPOVER_LEDGER_CONTENT_WAIVER");

  it("flags a set-but-unparseable content waiver, which would otherwise waive nothing in silence", () => {
    const problems = waiverProblems({ LOOPOVER_LEDGER_CONTENT_WAIVER: "5-257" }); // no reason
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("NOTHING is waived");
  });

  it("stays silent for an unset waiver (opt-in) and for a well-formed one", () => {
    expect(waiverProblems({})).toEqual([]);
    expect(waiverProblems({ LOOPOVER_LEDGER_CONTENT_WAIVER: "5-257:pre-9123 record overwrite" })).toEqual([]);
  });

  // #9933: same class again for the sibling UNCHAINED waiver -- a value that parses to nothing is worse than
  // an unset one, because the operator believes the orphans are declared.
  const unchainedProblems = (env: Record<string, string | undefined>) =>
    preflightEnv({ ...base, ...env }).problems.filter((p: SelfHostPreflightProblem) => p.var === "LOOPOVER_LEDGER_UNCHAINED_WAIVER");

  it("flags a set-but-unparseable unchained waiver, which would otherwise waive nothing in silence", () => {
    const problems = unchainedProblems({ LOOPOVER_LEDGER_UNCHAINED_WAIVER: "2026-07-04T00:00:00Z..2026-07-25T00:00:00Z|231" }); // no reason
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("NOTHING is waived");
  });

  it("stays silent for an unset unchained waiver (opt-in) and for a well-formed one", () => {
    expect(unchainedProblems({})).toEqual([]);
    expect(unchainedProblems({ LOOPOVER_LEDGER_UNCHAINED_WAIVER: "2026-07-04T00:00:00Z..2026-07-25T00:00:00Z|231|historical failed appends" })).toEqual([]);
  });

  it("INVARIANT: anchoring is opt-in — configuring none of it is never a problem", () => {
    expect(preflightEnv(base)).toEqual({ ok: true, problems: [] });
  });

  it("accepts a fully configured Rekor-only setup", () => {
    expect(anchorProblems({ LOOPOVER_LEDGER_ANCHOR_KEYS: key(), LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem" })).toEqual([]);
  });

  it("REGRESSION: catches a published key with no private half — silently disables anchoring today", () => {
    expect(anchorProblems({ LOOPOVER_LEDGER_ANCHOR_KEYS: key() })).toEqual([
      expect.objectContaining({ var: "LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY" }),
    ]);
  });

  it("REGRESSION: catches a private key with nothing published — anchors would be unverifiable", () => {
    expect(anchorProblems({ LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem" })).toEqual([
      expect.objectContaining({ var: "LOOPOVER_LEDGER_ANCHOR_KEYS" }),
    ]);
  });

  it("catches a key list that parses to nothing (malformed JSON, or entries missing required fields)", () => {
    for (const raw of ["not json", "{}", "[]", JSON.stringify([{ keyId: "k1" }])]) {
      expect(anchorProblems({ LOOPOVER_LEDGER_ANCHOR_KEYS: raw, LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem" })).toEqual([
        expect.objectContaining({ var: "LOOPOVER_LEDGER_ANCHOR_KEYS", message: expect.stringContaining("No usable entries") }),
      ]);
    }
  });

  it("catches a key list with no open-ended entry — no current signing key", () => {
    const problems = anchorProblems({ LOOPOVER_LEDGER_ANCHOR_KEYS: key({ notAfter: "2026-06-01T00:00:00.000Z" }), LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem" });
    expect(problems[0]?.message).toContain("No entry has notAfter: null");
  });

  it("catches an AMBIGUOUS rotation — more than one open-ended entry fails closed at runtime", () => {
    const twoOpen = JSON.stringify([
      { keyId: "k1", publicKeySpki: "c3BraQ==", notBefore: "2026-01-01T00:00:00.000Z", notAfter: null },
      { keyId: "k2", publicKeySpki: "c3BraR==", notBefore: "2026-02-01T00:00:00.000Z", notAfter: null },
    ]);
    const problems = anchorProblems({ LOOPOVER_LEDGER_ANCHOR_KEYS: twoOpen, LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem" });
    expect(problems[0]?.message).toContain("2 entries have notAfter: null");
  });

  it("catches a git target with no installation id — the backend is skipped silently", () => {
    expect(
      anchorProblems({
        LOOPOVER_LEDGER_ANCHOR_KEYS: key(),
        LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem",
        LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme",
        LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors",
      }),
    ).toEqual([expect.objectContaining({ var: "LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID" })]);
  });

  it("catches a non-positive-integer installation id", () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const problems = anchorProblems({
        LOOPOVER_LEDGER_ANCHOR_KEYS: key(),
        LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem",
        LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme",
        LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors",
        LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID: bad,
      });
      expect(problems.some((p) => p.message.includes("positive integer"))).toBe(true);
    }
  });

  it("catches half a git target in either direction", () => {
    const shared = { LOOPOVER_LEDGER_ANCHOR_KEYS: key(), LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem", LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID: "42" };
    expect(anchorProblems({ ...shared, LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme" })).toEqual([
      expect.objectContaining({ var: "LOOPOVER_LEDGER_ANCHOR_GIT_REPO" }),
    ]);
    expect(anchorProblems({ ...shared, LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors" })).toEqual([
      expect.objectContaining({ var: "LOOPOVER_LEDGER_ANCHOR_GIT_OWNER" }),
    ]);
  });

  it("accepts a fully configured git + Rekor setup", () => {
    expect(
      anchorProblems({
        LOOPOVER_LEDGER_ANCHOR_KEYS: key(),
        LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "pem",
        LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme",
        LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors",
        LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID: "42",
      }),
    ).toEqual([]);
  });
});
