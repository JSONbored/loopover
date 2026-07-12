import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Validation for the example K8s manifests (#5181). These are static infra artifacts (not src/** logic), so
// Codecov's patch gate doesn't apply to the YAML — but the safety property the manifests exist to guarantee
// (per-pod isolated SQLite storage, never a shared PVC across replicas) is asserted here as a real test, and the
// structural validator is exercised against both a well-formed manifest (passes) and a malformed one (fails).

const K8S_DIR = join(process.cwd(), "k8s");
const readManifest = (name: string): Record<string, unknown> =>
  parse(readFileSync(join(K8S_DIR, name), "utf8")) as Record<string, unknown>;

/** Minimal well-formedness check every Kubernetes resource must satisfy; throws on the first violation. */
function validateK8sResource(doc: unknown): { kind: string } {
  if (typeof doc !== "object" || doc === null)
    throw new Error("manifest is not a mapping");
  const m = doc as Record<string, unknown>;
  for (const field of ["apiVersion", "kind", "metadata"] as const) {
    if (m[field] == null)
      throw new Error(`manifest missing required field: ${field}`);
  }
  const metadata = m.metadata as Record<string, unknown>;
  if (typeof metadata.name !== "string" || metadata.name.length === 0) {
    throw new Error("manifest missing metadata.name");
  }
  return { kind: String(m.kind) };
}

/** The safety property this issue introduces: each replica gets its OWN volume, never one shared claim. */
function assertPerPodStorage(statefulSet: Record<string, unknown>): void {
  const spec = statefulSet.spec as Record<string, unknown> | undefined;
  const vcts = spec?.volumeClaimTemplates;
  if (!Array.isArray(vcts) || vcts.length === 0) {
    throw new Error(
      "no volumeClaimTemplates: replicas would not get per-pod storage",
    );
  }
  const template = spec?.template as Record<string, unknown> | undefined;
  const podSpec = template?.spec as Record<string, unknown> | undefined;
  const podVolumes =
    (podSpec?.volumes as Array<Record<string, unknown>> | undefined) ?? [];
  for (const volume of podVolumes) {
    if (volume.persistentVolumeClaim)
      throw new Error("a shared PVC across replicas is not allowed");
  }
}

describe("k8s miner manifests (#5181)", () => {
  const deployment = readManifest("miner-deployment.yaml");

  it("miner-deployment.yaml is a well-formed StatefulSet", () => {
    expect(validateK8sResource(deployment).kind).toBe("StatefulSet");
  });

  it("gives each replica its own SQLite volume (per-pod PVC, never a shared claim)", () => {
    expect(() => assertPerPodStorage(deployment)).not.toThrow();
    const spec = deployment.spec as Record<string, unknown>;
    expect((spec.volumeClaimTemplates as unknown[]).length).toBeGreaterThan(0);
    expect(typeof spec.replicas).toBe("number");
  });

  it("runs the continuous worker with config dir, a secret-sourced token, and resource bounds", () => {
    const containers = (deployment.spec as any).template.spec
      .containers as Array<Record<string, any>>;
    const container = containers[0];
    if (!container)
      throw new Error("no container in the StatefulSet pod template");
    expect(container.args).toContain("run");
    const env = container.env as Array<Record<string, any>>;
    const configDir = env.find((e) => e.name === "GITTENSORY_MINER_CONFIG_DIR");
    expect(configDir?.value).toBe("/data/miner");
    const token = env.find((e) => e.name === "GITHUB_TOKEN");
    expect(token?.valueFrom?.secretKeyRef?.key).toBe("GITHUB_TOKEN");
    expect(container.resources.requests).toBeTruthy();
    expect(container.resources.limits).toBeTruthy();
  });

  it("secret template is a well-formed Secret exposing GITHUB_TOKEN", () => {
    const secret = readManifest("miner-secret.example.yaml");
    expect(validateK8sResource(secret).kind).toBe("Secret");
    expect(
      (secret.stringData as Record<string, unknown>).GITHUB_TOKEN,
    ).toBeDefined();
  });

  it("the structural validator rejects a malformed manifest", () => {
    const malformed = parse("apiVersion: apps/v1\nmetadata:\n  name: broken\n"); // no `kind`
    expect(() => validateK8sResource(malformed)).toThrow(
      /missing required field: kind/,
    );
  });

  it("the per-pod-storage check rejects a shared-PVC configuration", () => {
    const shared = {
      spec: {
        volumeClaimTemplates: [{ metadata: { name: "data" } }],
        template: {
          spec: {
            volumes: [
              { name: "data", persistentVolumeClaim: { claimName: "shared" } },
            ],
          },
        },
      },
    };
    expect(() => assertPerPodStorage(shared)).toThrow(/shared PVC/);
  });

  it("the per-pod-storage check rejects a config with no volumeClaimTemplates", () => {
    expect(() =>
      assertPerPodStorage({ spec: { template: { spec: {} } } }),
    ).toThrow(/no volumeClaimTemplates/);
  });
});
