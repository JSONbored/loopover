import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

function readYamlWithMerge(path: string): Record<string, unknown> {
  const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
  const value = doc.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a YAML object`);
  }
  return value as Record<string, unknown>;
}

// Pure structural checks only (no `docker` CLI invocation): the self-hosted runner container this actually
// runs on does not have Docker-in-Docker access, so a test that shells out to `docker compose config`
// would be unreliable/environment-dependent here (same constraint as the other selfhost-compose-*.test.ts
// files). `{ merge: true }` makes the `yaml` package resolve `<<: *default-logging` the same way Docker
// Compose's own YAML 1.1 merge-key support does -- verified once by hand against `docker compose config`
// with every profile active before this test was written.
describe("docker-compose.yml — bounded container logging (#audit-rate-headroom)", () => {
  it("caps every service's logs via the shared x-logging anchor, so none defaults to Docker's unbounded json-file driver", () => {
    const compose = readYamlWithMerge("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};
    const serviceNames = Object.keys(services);

    // Guard against a future service quietly skipping the anchor (e.g. a copy-pasted block that dropped the
    // merge key) -- every single service must resolve a bounded logging config, not just a sample of them.
    expect(serviceNames.length).toBeGreaterThan(15);
    for (const name of serviceNames) {
      const logging = services[name]?.logging as { driver?: string; options?: Record<string, string> } | undefined;
      expect(logging, `service "${name}" is missing a logging config`).toBeDefined();
      expect(logging?.driver).toBe("json-file");
      expect(logging?.options?.["max-size"]).toBe("10m");
      expect(logging?.options?.["max-file"]).toBe("3");
    }
  });

  it("defines the shared anchor once with a sane cap, so a future edit only needs to change one place", () => {
    const compose = readYamlWithMerge("docker-compose.yml");
    const shared = compose["x-logging"] as { logging?: { driver?: string; options?: Record<string, string> } };

    expect(shared?.logging?.driver).toBe("json-file");
    expect(shared?.logging?.options?.["max-size"]).toBe("10m");
    expect(shared?.logging?.options?.["max-file"]).toBe("3");
  });
});
