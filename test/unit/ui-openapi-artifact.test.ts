import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildOpenApiSpec } from "../../src/openapi/spec";

const FORBIDDEN_EXAMPLE_PATTERN =
  /wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i;

const artifactPath = resolve(
  process.cwd(),
  "apps/gittensory-ui/public/openapi.json",
);

function collectJsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectJsonStrings(nested, out);
    }
  }
  return out;
}

describe("UI OpenAPI artifact", () => {
  it("matches the generated modern contract and production server only", () => {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      paths?: Record<string, unknown>;
      servers?: Array<{ url: string }>;
    };
    const spec = buildOpenApiSpec();
    expect(Object.keys(artifact.paths ?? {}).sort()).toEqual(Object.keys(spec.paths ?? {}).sort());
    expect(artifact.servers).toEqual([
      { url: "https://gittensory-api.aethereal.dev", description: "Production" },
    ]);
    for (const server of artifact.servers ?? []) {
      expect(server.url).not.toMatch(/workers\.dev/i);
      expect(server.description ?? "").not.toMatch(/preview worker/i);
    }
  });

  it("keeps response examples free of public-forbidden language", () => {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;
    const strings = collectJsonStrings(artifact);
    const offenders = strings.filter((s) => FORBIDDEN_EXAMPLE_PATTERN.test(s) && s.length < 500);
    expect(offenders).toEqual([]);
  });
});
