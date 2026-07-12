import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODING_AGENT_DRIVER_CONFIG_ENV, CODING_AGENT_DRIVER_NAMES } from "../../packages/gittensory-engine/src/index";

const README_PATH = join(process.cwd(), "packages/gittensory-miner/README.md");
const DEPLOYMENT_PATH = join(process.cwd(), "packages/gittensory-miner/DEPLOYMENT.md");
const CLI_SUBPROCESS_DRIVER_PATH = join(
  process.cwd(),
  "packages/gittensory-engine/src/miner/cli-subprocess-driver.ts",
);

// Every env var CODING_AGENT_DRIVER_CONFIG_ENV actually declares as consumed, across every provider --
// this is the same set driver-factory.ts's own header comment says is "the source of truth" (#5172).
const CONFIGURED_ENV_VAR_NAMES = [
  ...new Set(
    Object.values(CODING_AGENT_DRIVER_CONFIG_ENV).flatMap((entry) => Object.values(entry).filter((v) => v !== undefined)),
  ),
];

describe("miner coding-agent driver env var docs (#5172)", () => {
  it("documents MINER_CODING_AGENT_PROVIDER and every per-provider env var driver-factory.ts declares", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("## Coding-agent driver configuration");
    expect(readme).toContain("MINER_CODING_AGENT_PROVIDER");
    for (const envVar of CONFIGURED_ENV_VAR_NAMES) {
      expect(readme).toContain(envVar);
    }
  });

  it("documents every accepted MINER_CODING_AGENT_PROVIDER value from CODING_AGENT_DRIVER_NAMES", () => {
    const readme = readFileSync(README_PATH, "utf8");
    for (const name of CODING_AGENT_DRIVER_NAMES) {
      expect(readme).toContain(`\`${name}\``);
    }
  });

  it("documents the real default CLI timeout from cli-subprocess-driver.ts", () => {
    const driverSource = readFileSync(CLI_SUBPROCESS_DRIVER_PATH, "utf8");
    const match = driverSource.match(/DEFAULT_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
    expect(match).not.toBeNull();
    const defaultTimeoutMs = Number((match?.[1] ?? "").replaceAll("_", ""));
    expect(defaultTimeoutMs).toBeGreaterThan(0);

    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain(`\`${defaultTimeoutMs}\``);
  });

  it("cross-references the README's env var section from DEPLOYMENT.md instead of duplicating it", () => {
    const deployment = readFileSync(DEPLOYMENT_PATH, "utf8");
    expect(deployment).toContain("README.md#coding-agent-driver-configuration");
  });

  it("cross-references docs/coding-agent-driver.md rather than duplicating its interface-level content", () => {
    const readme = readFileSync(README_PATH, "utf8");
    const section = readme.slice(
      readme.indexOf("## Coding-agent driver configuration"),
      readme.indexOf("## MCP server"),
    );
    expect(section).toContain("docs/coding-agent-driver.md");
  });
});
