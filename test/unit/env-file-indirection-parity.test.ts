import { describe, expect, it, vi } from "vitest";
import { loadMinerFileSecrets } from "../../packages/loopover-miner/lib/env-file-indirection";
import { loadFileSecrets } from "../../src/selfhost/load-file-secrets";

/**
 * #7530: `env-file-indirection.ts` long claimed it "deliberately diverges" from
 * `src/selfhost/load-file-secrets.ts` by throwing where the ORB analogue logged and continued. That stopped
 * being true when ORB converged onto the same fail-fast behavior in #6284, but the miner-side comment was
 * never updated, so a reader was told the wrong module was stricter.
 *
 * Correcting the comment alone would leave nothing stopping the two from drifting apart again -- and a
 * silent divergence here is a real hazard, since it decides whether a broken secret mount fails the
 * container or leaves a credential quietly unset. These assertions pin the convergence the comment now
 * documents: both resolvers are given the SAME inputs and must agree.
 */
const RESOLVERS: ReadonlyArray<{
  name: string;
  load: (env: Record<string, string | undefined>, readFile: (path: string) => string) => void;
}> = [
  { name: "loadMinerFileSecrets", load: loadMinerFileSecrets },
  { name: "loadFileSecrets", load: loadFileSecrets },
];

const unreadable = () => {
  throw new Error("ENOENT: no such file or directory");
};

describe("env-file-indirection <-> load-file-secrets parity (#7530, converged in #6284)", () => {
  it.each(RESOLVERS)("$name throws on an unreadable <NAME>_FILE", ({ load }) => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/missing" };

    expect(() => load(env, unreadable)).toThrow(/GITHUB_TOKEN_FILE/);
    // Never silently leaves the credential unset -- that is the whole point of failing closed.
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it.each(RESOLVERS)("$name names the offending var and path, never the secret's contents", ({ load }) => {
    let thrown: unknown;
    try {
      load({ GITHUB_TOKEN_FILE: "/run/secrets/gh" }, unreadable);
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("GITHUB_TOKEN_FILE");
    expect(message).toContain("/run/secrets/gh");
  });

  it.each(RESOLVERS)("$name resolves a readable file into the bare var", ({ load }) => {
    const env: Record<string, string | undefined> = { GITHUB_TOKEN_FILE: "/run/secrets/gh" };

    load(env, () => "  ghp_value\n");

    expect(env.GITHUB_TOKEN).toBe("ghp_value");
  });

  it.each(RESOLVERS)("$name lets an explicit <NAME> win over <NAME>_FILE", ({ load }) => {
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: "explicit",
      GITHUB_TOKEN_FILE: "/run/secrets/gh",
    };
    const readFile = vi.fn(() => "from-file");

    load(env, readFile);

    expect(env.GITHUB_TOKEN).toBe("explicit");
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(RESOLVERS)("$name ignores Docker Compose's own reserved _FILE vars", ({ load }) => {
    const env: Record<string, string | undefined> = {
      COMPOSE_FILE: "a.yml:b.yml",
      COMPOSE_ENV_FILE: "/app/.env",
    };
    const readFile = vi.fn(() => "never");

    expect(() => load(env, readFile)).not.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(env.COMPOSE).toBeUndefined();
  });
});
