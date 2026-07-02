import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

function readYaml(path: string): Record<string, unknown> {
  const value = parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a YAML object`);
  }
  return value as Record<string, unknown>;
}

// A burst of CI jobs (--profile runners) can starve the main `gittensory` app of CPU on a shared host
// with no limits set (the default). docker-compose.override.yml.example documents a proven cpu_shares +
// cpus pattern for that case -- pure structural checks only (no `docker` CLI invocation: the self-hosted
// runner container this actually runs on does not have Docker-in-Docker access, so a test that shells out
// to `docker compose config` would be unreliable/environment-dependent here).
describe("docker-compose.override.yml.example", () => {
  it("is valid YAML whose service keys exist in the real docker-compose.yml", () => {
    const example = readYaml("docker-compose.override.yml.example");
    const base = readYaml("docker-compose.yml");
    const exampleServices = Object.keys(example.services as Record<string, unknown>);
    const baseServices = Object.keys(base.services as Record<string, unknown>);

    expect(exampleServices).toEqual(["gittensory", "runner"]);
    for (const name of exampleServices) {
      expect(baseServices).toContain(name);
    }
  });

  it("gives the app service a higher relative cpu_shares weight than the runner service", () => {
    const example = readYaml("docker-compose.override.yml.example");
    const services = example.services as Record<string, Record<string, unknown>>;

    const appShares = Number(services.gittensory?.cpu_shares);
    const runnerShares = Number(services.runner?.cpu_shares);
    expect(Number.isFinite(appShares) && Number.isFinite(runnerShares)).toBe(true);
    expect(appShares).toBeGreaterThan(runnerShares);
  });

  it(".gitignore excludes a real docker-compose.override.yml but keeps the example tracked", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    expect(gitignore).toContain("docker-compose.override.yml\n");
    expect(gitignore).toContain("!docker-compose.override.yml.example");
  });
});
