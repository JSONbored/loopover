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

// Pure structural checks only (no `docker` CLI invocation): the self-hosted runner container this actually
// runs on does not have Docker-in-Docker access, so a test that shells out to `docker compose config`
// would be unreliable/environment-dependent here (same constraint as docker-compose-override-example.test.ts).
describe("docker-compose.yml — per-service memory limits (#1828, #2495, #3893)", () => {
  const EXPECTED_LIMITS: Record<string, string> = {
    gittensory: "${GITTENSORY_MEM_LIMIT:-2g}",
    redis: "${REDIS_MEM_LIMIT:-512m}",
    postgres: "${POSTGRES_MEM_LIMIT:-2g}",
    qdrant: "${QDRANT_MEM_LIMIT:-2g}",
    ollama: "${OLLAMA_MEM_LIMIT:-20g}", // raised from 8g (#4335): a vision model now shares this ceiling with bge-m3
    prometheus: "${PROMETHEUS_MEM_LIMIT:-1g}",
    loki: "${LOKI_MEM_LIMIT:-1g}",
    tempo: "${TEMPO_MEM_LIMIT:-1g}",
    grafana: "${GRAFANA_MEM_LIMIT:-512m}",
    runner: "${RUNNER_MEM_LIMIT:-2g}",
    alertmanager: "${ALERTMANAGER_MEM_LIMIT:-256m}",
    "docker-proxy": "${DOCKER_PROXY_MEM_LIMIT:-64m}",
    promtail: "${PROMTAIL_MEM_LIMIT:-256m}",
    "otel-collector": "${OTEL_COLLECTOR_MEM_LIMIT:-512m}",
  };

  it("caps the core app and every heavyweight optional service with an operator-overridable memory limit", () => {
    const compose = readYaml("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};

    for (const [name, expected] of Object.entries(EXPECTED_LIMITS)) {
      const service = services[name];
      expect(service, name).toBeTruthy();
      const deploy = service?.deploy as { resources?: { limits?: { memory?: unknown } } } | undefined;
      expect(deploy?.resources?.limits?.memory, name).toBe(expected);
    }
  });

  it("documents every memory-limit override variable in .env.example", () => {
    const env = readFileSync(".env.example", "utf8");

    for (const key of [
      "GITTENSORY_MEM_LIMIT",
      "REDIS_MEM_LIMIT",
      "POSTGRES_MEM_LIMIT",
      "QDRANT_MEM_LIMIT",
      "OLLAMA_MEM_LIMIT",
      "PROMETHEUS_MEM_LIMIT",
      "LOKI_MEM_LIMIT",
      "TEMPO_MEM_LIMIT",
      "GRAFANA_MEM_LIMIT",
      "RUNNER_MEM_LIMIT",
      "ALERTMANAGER_MEM_LIMIT",
      "DOCKER_PROXY_MEM_LIMIT",
      "PROMTAIL_MEM_LIMIT",
      "OTEL_COLLECTOR_MEM_LIMIT",
    ]) {
      expect(env, key).toContain(key);
    }
  });
});

// Concurrency/residency tuning for a shared embed+vision GPU deployment (#4327/#4335) — separate describe
// block from the memory-limit checks above since these are `environment:` entries, not `deploy.resources`.
describe("docker-compose.yml — ollama concurrency/residency env vars (#4327, #4335)", () => {
  const EXPECTED_OLLAMA_ENV: Record<string, string> = {
    OLLAMA_NUM_PARALLEL: "${OLLAMA_NUM_PARALLEL:-2}",
    OLLAMA_MAX_LOADED_MODELS: "${OLLAMA_MAX_LOADED_MODELS:-2}",
    OLLAMA_KEEP_ALIVE: "${OLLAMA_KEEP_ALIVE:-30m}",
  };

  it("sets an operator-overridable default for every ollama concurrency/residency variable", () => {
    const compose = readYaml("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};
    const environment = (services.ollama?.environment as Record<string, unknown>) ?? {};

    for (const [key, expected] of Object.entries(EXPECTED_OLLAMA_ENV)) {
      expect(environment[key], key).toBe(expected);
    }
  });

  it("documents every ollama concurrency/residency override variable in .env.example", () => {
    const env = readFileSync(".env.example", "utf8");

    for (const key of Object.keys(EXPECTED_OLLAMA_ENV)) {
      expect(env, key).toContain(key);
    }
  });
});
