import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Validation for the AMS fleet-mode compose file (#5177). Not `src/**` logic, so Codecov doesn't gate it — but
// the structural contract (service built from the package Dockerfile, named volume for SQLite persistence,
// restart policy, credentials via env-file not inlined) is asserted here as a real test, and the env example is
// checked to ship only empty (secret-scanner-safe) placeholders.
const MINER_DIR = join(process.cwd(), "packages/gittensory-miner");
const compose = parse(
  readFileSync(join(MINER_DIR, "docker-compose.miner.yml"), "utf8"),
) as Record<string, any>;
const envExample = readFileSync(
  join(MINER_DIR, ".gittensory-miner.env.example"),
  "utf8",
);

describe("docker-compose.miner.yml (#5177)", () => {
  it("defines a miner service built from the package Dockerfile (monorepo-root context)", () => {
    const miner = compose.services?.miner;
    expect(miner).toBeTruthy();
    expect(miner.build.dockerfile).toBe("packages/gittensory-miner/Dockerfile");
    expect(miner.build.context).toBe("../..");
    expect(miner.command).toContain("run");
  });

  it("persists state on a named volume and restarts unless stopped", () => {
    const miner = compose.services.miner;
    expect(miner.restart).toBe("unless-stopped");
    expect(miner.volumes).toContain("miner-data:/data/miner");
    expect(compose.volumes).toHaveProperty("miner-data");
  });

  it("sources credentials from an env file and pins nothing overridable in `environment`", () => {
    const miner = compose.services.miner;
    expect(miner.env_file).toContain(".gittensory-miner.env");
    const envBlock = JSON.stringify(miner.environment ?? {});
    // no secret-named key is assigned a value directly in the compose `environment` block
    expect(envBlock).not.toMatch(/TOKEN|API_KEY|SECRET|PASSWORD/i);
    // regression: GITTENSORY_MINER_CONFIG_DIR must NOT be pinned in `environment` — Compose's `environment`
    // silently overrides `env_file`, so pinning it here would make any env-file override a dead footgun.
    expect(envBlock).not.toMatch(/GITTENSORY_MINER_CONFIG_DIR/);
  });

  it("gitignores the operator's real env file while keeping the committed example", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.gittensory-miner\.env$/m);
    expect(gitignore).toMatch(/^!\.gittensory-miner\.env\.example$/m);
  });

  it("ships an env example with empty (scanner-safe) placeholder values for every credential", () => {
    for (const key of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      expect(envExample).toMatch(new RegExp(`^${key}=\\s*$`, "m"));
    }
  });
});
