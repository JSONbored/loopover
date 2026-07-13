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
    expect(script).toContain("loopover-selfhost-smoke");
    expect(script).toContain("selfhost.observability.smoke");
  });

  it("ships an operator smoke probe that verifies collector-to-Prometheus-exporter metrics retrieval, plus the app's own /metrics shape (2026-07 fix)", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts/smoke-observability-metrics.mjs"),
      "utf8",
    );

    expect(script).toContain("http://otel-collector:4318/v1/metrics");
    expect(script).toContain("http://otel-collector:8889/metrics");
    expect(script).toContain("http://localhost:8787/metrics");
    expect(script).toContain("loopover-selfhost-smoke");
    expect(script).toContain("# HELP loopover_uptime_seconds");

    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["test:smoke:observability:metrics"]).toBe(
      "node scripts/smoke-observability-metrics.mjs",
    );
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
      DATA_SOURCE_URI: "postgres:5432/loopover?sslmode=disable",
      DATA_SOURCE_USER: "loopover",
      DATA_SOURCE_PASS: "${POSTGRES_PASSWORD:-CHANGEME}",
    });

    expect(backupExporter.profiles).toEqual(["backup"]);
    expect(backupExporter.volumes).toEqual(
      expect.arrayContaining([
        "loopover-backups:/backups:ro",
        "./scripts:/scripts:ro",
      ]),
    );
    expect(backupExporter.command).toEqual([
      "/bin/sh",
      "-c",
      "apk add --no-cache busybox-extras && sh /scripts/backup-metrics.sh",
    ]);
    expect(backupExporter.healthcheck?.test).toEqual([
      "CMD-SHELL",
      "wget -qO- http://127.0.0.1:9101/metrics | grep -q '^loopover_backup_latest_timestamp_seconds'",
    ]);

    expect(scrapeConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_name: "postgres",
          static_configs: [{ targets: ["postgres-exporter:9187"] }],
        }),
        expect.objectContaining({
          job_name: "gittensory-backup",
          fallback_scrape_protocol: "PrometheusText0.0.4",
          static_configs: [{ targets: ["backup-exporter:9101"] }],
        }),
      ]),
    );
  });

  it("wires host/container/Redis metrics and stack self-monitoring without Docker socket access (#5366)", () => {
    const compose = record(readYaml("docker-compose.yml"));
    const services = record(compose.services);
    const prometheus = record(readYaml("prometheus/prometheus.yml"));
    const scrapeConfigs = prometheus.scrape_configs as Array<Record<string, any>>;

    const nodeExporter = record(services["node-exporter"]);
    expect(nodeExporter.image).toBe("prom/node-exporter:v1.9.1");
    expect(nodeExporter.profiles).toEqual(["observability"]);
    expect(nodeExporter.volumes).toEqual(
      expect.arrayContaining(["/proc:/host/proc:ro", "/sys:/host/sys:ro", "/:/rootfs:ro"]),
    );
    expect(nodeExporter.command).toEqual(
      expect.arrayContaining([
        "--path.procfs=/host/proc",
        "--path.sysfs=/host/sys",
        "--path.rootfs=/rootfs",
      ]),
    );
    expect(nodeExporter.expose).toEqual(["9100"]);
    // Neither host networking nor a privileged container: read-only host-directory bind mounts alone.
    expect(nodeExporter.network_mode).toBeUndefined();
    expect(nodeExporter.privileged).toBeUndefined();

    const cadvisor = record(services.cadvisor);
    expect(cadvisor.image).toBe("gcr.io/cadvisor/cadvisor:v0.49.2");
    expect(cadvisor.profiles).toEqual(["observability"]);
    expect(cadvisor.volumes).toEqual(
      expect.arrayContaining([
        "/:/rootfs:ro",
        "/sys:/sys:ro",
        "/var/lib/docker/:/var/lib/docker:ro",
        "/dev/disk/:/dev/disk:ro",
      ]),
    );
    expect(cadvisor.expose).toEqual(["8080"]);
    // Deliberate: no Docker socket mount, matching this repo's own docker-proxy security posture (a
    // read-only socket bind mount does not limit the Docker API surface behind it).
    expect(JSON.stringify(cadvisor)).not.toContain("docker.sock");

    const redisExporter = record(services["redis-exporter"]);
    expect(redisExporter.image).toBe("oliver006/redis_exporter:v1.79.0");
    expect(redisExporter.profiles).toEqual(["observability"]);
    expect(redisExporter.depends_on?.redis).toEqual({ condition: "service_healthy" });
    expect(redisExporter.environment?.REDIS_ADDR).toBe("redis://redis:6379");
    expect(redisExporter.expose).toEqual(["9121"]);

    expect(scrapeConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_name: "node-exporter",
          static_configs: [{ targets: ["node-exporter:9100"] }],
        }),
        expect.objectContaining({
          job_name: "cadvisor",
          static_configs: [{ targets: ["cadvisor:8080"] }],
        }),
        expect.objectContaining({
          job_name: "redis",
          static_configs: [{ targets: ["redis-exporter:9121"] }],
        }),
        expect.objectContaining({
          job_name: "qdrant",
          static_configs: [{ targets: ["qdrant:6333"] }],
        }),
        expect.objectContaining({
          job_name: "observability-stack",
          static_configs: [
            {
              targets: [
                "prometheus:9090",
                "alertmanager:9093",
                "loki:3100",
                "tempo:3200",
                "grafana:3000",
                "otel-collector:8888",
              ],
            },
          ],
        }),
      ]),
    );
  });

  it("exposes the OTEL collector's own internal telemetry on a port distinct from the re-exported Claude Code metrics (#5366)", () => {
    const collector = record(readYaml("otel/otel-collector-config.yml"));
    const readers = record(collector.service).telemetry?.metrics?.readers;

    expect(Array.isArray(readers)).toBe(true);
    expect(readers[0].pull.exporter.prometheus).toEqual({
      host: "0.0.0.0",
      port: 8888,
    });
    // 8888 (internal telemetry) must never collide with 8889 (the `prometheus` exporter re-exposing
    // forwarded Claude Code OTLP data) -- both are scraped, but they carry structurally different metrics.
    expect(record(collector.exporters).prometheus.endpoint).toBe("0.0.0.0:8889");
  });

  it("scrapes REES's own /metrics, gated on the optional rees profile (#5367)", () => {
    const compose = record(readYaml("docker-compose.yml"));
    const rees = record(record(compose.services).rees);
    const prometheus = record(readYaml("prometheus/prometheus.yml"));
    const scrapeConfigs = prometheus.scrape_configs as Array<Record<string, any>>;

    expect(rees.profiles).toEqual(["rees"]);
    expect(rees.expose).toEqual(["8080"]);
    expect(scrapeConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_name: "rees",
          static_configs: [{ targets: ["rees:8080"] }],
        }),
      ]),
    );
  });

  it("translates browserless's JSON /metrics into Prometheus text via a sidecar, gated on --profile visual-review (#5368)", () => {
    const compose = record(readYaml("docker-compose.yml"));
    const services = record(compose.services);
    const browserlessExporter = record(services["browserless-exporter"]);
    const prometheus = record(readYaml("prometheus/prometheus.yml"));
    const scrapeConfigs = prometheus.scrape_configs as Array<Record<string, any>>;

    expect(browserlessExporter.image).toBe("alpine:3.20");
    expect(browserlessExporter.profiles).toEqual(["visual-review"]);
    expect(browserlessExporter.depends_on?.browserless).toEqual({ condition: "service_healthy" });
    expect(browserlessExporter.environment).toMatchObject({
      BROWSERLESS_METRICS_URL: "http://browserless:3000/metrics",
      BROWSERLESS_TOKEN: "${BROWSERLESS_TOKEN:-}",
    });
    expect(browserlessExporter.expose).toEqual(["9102"]);
    expect(browserlessExporter.command).toEqual([
      "/bin/sh",
      "-c",
      "apk add --no-cache jq busybox-extras >/dev/null 2>&1 && sh /scripts/browserless-metrics.sh",
    ]);
    expect(browserlessExporter.healthcheck?.test).toEqual([
      "CMD-SHELL",
      "wget -qO- http://127.0.0.1:9102/metrics | grep -q '^browserless_exporter_last_scrape_success'",
    ]);

    expect(scrapeConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_name: "browserless",
          fallback_scrape_protocol: "PrometheusText0.0.4",
          static_configs: [{ targets: ["browserless-exporter:9102"] }],
        }),
      ]),
    );
  });

  it("ships the browserless-metrics.sh translator with the newest-window-wins + scrape-failure-safe shape it claims", () => {
    const script = readFileSync(join(process.cwd(), "scripts/browserless-metrics.sh"), "utf8");

    // Picks the LAST array element (browserless's rolling history is oldest-first), not the first or a merge.
    expect(script).toContain("jq -c '.[-1] // empty'");
    // A failed poll must not corrupt/blank the previously-served file: written atomically via tmp+mv, and the
    // failure branch still emits a valid, parseable metrics document (just success=0) rather than an empty body.
    expect(script).toContain('mv "$tmp" "$FILE"');
    expect(script).toContain("browserless_exporter_last_scrape_success 0");
    expect(script).toContain("browserless_exporter_last_scrape_success 1");
  });
});
