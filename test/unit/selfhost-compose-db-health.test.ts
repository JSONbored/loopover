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
describe("docker-compose.yml — postgres/pgbouncer startup ordering (#2500, #2503)", () => {
  it("gates the core app on a healthy postgres and pgbouncer without requiring either profile", () => {
    const compose = readYaml("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};
    const app = services.loopover ?? {};
    const dependsOn = app.depends_on as Record<string, { condition?: string; required?: boolean }>;

    // redis stays required (always-on service); postgres/pgbouncer/qdrant are all required:false since only
    // a subset of profiles start them — a default (no-profile) SQLite deployment must not wait on any of them.
    expect(dependsOn.redis).toEqual({ condition: "service_healthy" });
    expect(dependsOn.postgres).toEqual({ condition: "service_healthy", required: false });
    expect(dependsOn.pgbouncer).toEqual({ condition: "service_healthy", required: false });
    expect(dependsOn.qdrant).toEqual({ condition: "service_healthy", required: false });
  });

  it("gives pgbouncer a healthcheck so loopover's depends_on has a real readiness signal to gate on", () => {
    const compose = readYaml("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};
    const pgbouncer = services.pgbouncer ?? {};
    const healthcheck = pgbouncer.healthcheck as { test?: unknown[]; interval?: string; retries?: number };

    // pg_isready only confirms the server accepts the startup packet, not that auth succeeds against the
    // real upstream postgres -- correct for a pooler-layer liveness probe, mirroring the postgres service's
    // own healthcheck shape (also pg_isready-based).
    expect(healthcheck.test).toEqual(["CMD", "pg_isready", "-h", "127.0.0.1", "-p", "5432"]);
    expect(healthcheck.retries).toBeGreaterThan(0);
  });

  it("still starts pgbouncer only after a healthy postgres (unaffected by the new loopover dependency)", () => {
    const compose = readYaml("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};
    const pgbouncer = services.pgbouncer ?? {};
    const dependsOn = pgbouncer.depends_on as Record<string, { condition?: string }>;

    expect(dependsOn.postgres).toEqual({ condition: "service_healthy" });
  });

  it("gives postgres and pgbouncer a start_period so a cold pg_isready probe isn't marked unhealthy (#3898)", () => {
    const compose = readYaml("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};

    // Every failed probe counts toward `retries` from the very first check unless start_period is set --
    // a genuinely cold pgvector initdb (first pull, slow disk) can plausibly exceed 5 retries at 10s each
    // with no grace period, marking postgres unhealthy and failing every service_healthy depends_on gate.
    for (const name of ["postgres", "pgbouncer"]) {
      const healthcheck = (services[name] ?? {}).healthcheck as { start_period?: string } | undefined;
      expect(healthcheck?.start_period, name).toBeTruthy();
    }
  });
});
