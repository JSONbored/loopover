import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function readYaml(path: string): unknown {
  return parse(readFileSync(join(process.cwd(), path), "utf8"));
}

function record(value: unknown): Record<string, any> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  return value as Record<string, any>;
}

describe("self-host observability trace config", () => {
  it("gates Tempo consumers without breaking the default Compose profile", () => {
    const compose = record(readYaml("docker-compose.yml"));
    const services = record(compose.services);
    const tempo = record(services.tempo);
    const grafana = record(services.grafana);
    const collector = record(services["otel-collector"]);

    expect(tempo.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "-qO-",
      "http://127.0.0.1:3200/ready",
    ]);
    expect(tempo.healthcheck?.start_period).toBe("20s");
    expect(tempo.healthcheck?.retries).toBe(12);
    expect(grafana.depends_on?.tempo).toBeUndefined();
    expect(collector.depends_on?.tempo).toEqual({
      condition: "service_healthy",
    });
    expect(grafana.environment?.GF_SECURITY_ADMIN_PASSWORD).toBe(
      "${GRAFANA_ADMIN_PASSWORD:-${GRAFANA_LOCAL_SMOKE_PASSWORD:-}}",
    );
    expect(JSON.stringify(grafana)).not.toContain("changeme");
    expect(grafana.entrypoint).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Set GRAFANA_ADMIN_PASSWORD"),
        expect.stringContaining("exec /run.sh"),
      ]),
    );

    for (const [name, service] of Object.entries(services)) {
      const serviceRecord = record(service);
      if (!serviceRecord.depends_on?.tempo) continue;
      expect(serviceRecord.profiles, name).toContain("observability");
      expect(tempo.profiles, "tempo").toContain("observability");
    }
  });

  it("keeps the collector, Tempo, and Grafana data source on the same trace path", () => {
    const collector = record(readYaml("otel/otel-collector-config.yml"));
    const tempo = record(readYaml("tempo/tempo.yaml"));
    const datasource = record(
      readYaml("grafana/provisioning/datasources/tempo.yml"),
    );

    expect(record(collector.exporters)["otlp/tempo"].endpoint).toBe(
      "tempo:4317",
    );
    expect(
      record(record(collector.service).pipelines).traces.exporters,
    ).toEqual(["otlp/tempo"]);
    expect(
      record(record(record(record(tempo.distributor).receivers).otlp).protocols)
        .grpc.endpoint,
    ).toBe("0.0.0.0:4317");
    expect(
      record(record(record(record(tempo.distributor).receivers).otlp).protocols)
        .http.endpoint,
    ).toBe("0.0.0.0:4318");
    expect(record(record(tempo.storage).trace).backend).toBe("local");
    expect(record(datasource.datasources?.[0]).url).toBe("http://tempo:3200");
  });

  it("ships an operator smoke probe that verifies collector to Tempo retrieval", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts/smoke-observability-traces.mjs"),
      "utf8",
    );

    expect(script).toContain("http://otel-collector:4318/v1/traces");
    expect(script).toContain("http://tempo:3200/api/traces/");
    expect(script).toContain("gittensory-selfhost-smoke");
    expect(script).toContain("selfhost.observability.smoke");
  });

  it("wires Postgres and backup exporters without starting them on SQLite-only observability", () => {
    const compose = record(readYaml("docker-compose.yml"));
    const services = record(compose.services);
    const postgresExporter = record(services["postgres-exporter"]);
    const backupExporter = record(services["backup-exporter"]);
    const prometheus = record(readYaml("prometheus/prometheus.yml"));
    const scrapeConfigs = prometheus.scrape_configs as Array<Record<string, any>>;

    expect(postgresExporter.image).toBe("quay.io/prometheuscommunity/postgres-exporter:v0.20.0");
    expect(postgresExporter.profiles).toEqual(["postgres", "pgbouncer"]);
    expect(postgresExporter.depends_on?.postgres).toEqual({ condition: "service_healthy" });
    expect(postgresExporter.environment).toMatchObject({
      DATA_SOURCE_URI: "postgres:5432/gittensory?sslmode=disable",
      DATA_SOURCE_USER: "gittensory",
      DATA_SOURCE_PASS: "${POSTGRES_PASSWORD:-CHANGEME}",
    });

    expect(backupExporter.profiles).toEqual(["backup"]);
    expect(backupExporter.volumes).toEqual(
      expect.arrayContaining([
        "gittensory-backups:/backups:ro",
        "./scripts/backup-metrics.sh:/backup-metrics.sh:ro",
      ]),
    );
    expect(backupExporter.healthcheck?.test).toEqual([
      "CMD-SHELL",
      "wget -qO- http://127.0.0.1:9101/metrics | grep -q '^gittensory_backup_latest_timestamp_seconds'",
    ]);

    expect(scrapeConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_name: "postgres",
          static_configs: [{ targets: ["postgres-exporter:9187"] }],
        }),
        expect.objectContaining({
          job_name: "gittensory-backup",
          static_configs: [{ targets: ["backup-exporter:9101"] }],
        }),
      ]),
    );
  });
});
