import { describe, expect, it } from "vitest";
import { validateSourcemap } from "../../scripts/validate-selfhost-sourcemap.js";

const BUNDLE = "/tmp/dist/server.mjs";
const MAP = "/tmp/dist/server.mjs.map";

const VALID_BUNDLE = "export {};\n//# sourceMappingURL=server.mjs.map\n";

function validMap(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    sources: ["../src/server.ts"],
    sourcesContent: ["export function start() {}\n"],
    mappings: "AAAA",
    ...overrides,
  });
}

function harness(files: Record<string, string | undefined>) {
  return {
    bundlePath: BUNDLE,
    mapPath: MAP,
    exists: (path: string) => Object.prototype.hasOwnProperty.call(files, path) && files[path] !== undefined,
    readFile: (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

describe("validate-selfhost-sourcemap.ts (#7458)", () => {
  it("passes a well-formed minimal source map", () => {
    expect(
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap(),
        }),
      ),
    ).toEqual({ sourceCount: 1 });
  });

  it("fails when the bundle is missing", () => {
    expect(() => validateSourcemap(harness({ [MAP]: validMap() }))).toThrow("dist/server.mjs is missing");
  });

  it("fails when the map is missing", () => {
    expect(() => validateSourcemap(harness({ [BUNDLE]: VALID_BUNDLE }))).toThrow("dist/server.mjs.map is missing");
  });

  it("fails when the bundle is missing the sourceMappingURL comment", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: "export {};\n",
          [MAP]: validMap(),
        }),
      ),
    ).toThrow("dist/server.mjs is missing the server.mjs.map sourceMappingURL");
  });

  it("fails when the map is not valid JSON", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: "{ not json",
        }),
      ),
    ).toThrow(/dist\/server\.mjs\.map is not valid JSON/);
  });

  it("fails when the map is not version 3", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap({ version: 2 }),
        }),
      ),
    ).toThrow("dist/server.mjs.map is not a version 3 source map");
  });

  it("fails when sources is empty", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap({ sources: [], sourcesContent: [] }),
        }),
      ),
    ).toThrow("dist/server.mjs.map has no original sources");
  });

  it("fails when sourcesContent length does not match sources", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap({ sourcesContent: [] }),
        }),
      ),
    ).toThrow("dist/server.mjs.map must include sourcesContent for every original source");
  });

  it("fails when src/server.ts is missing from sources", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap({
            sources: ["../src/other.ts"],
            sourcesContent: ["export {}\n"],
          }),
        }),
      ),
    ).toThrow("dist/server.mjs.map does not include src/server.ts");
  });

  it("fails when src/server.ts source content is empty", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap({
            sources: ["../src/server.ts"],
            sourcesContent: ["   "],
          }),
        }),
      ),
    ).toThrow("dist/server.mjs.map has empty source content for src/server.ts");
  });

  it("fails when no repository-relative ../src/ sources are present", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap({
            sources: ["src/server.ts"],
            sourcesContent: ["export function start() {}\n"],
          }),
        }),
      ),
    ).toThrow("dist/server.mjs.map does not include repository sources");
  });

  it("fails when a repository-relative source has empty content", () => {
    expect(() =>
      validateSourcemap(
        harness({
          [BUNDLE]: VALID_BUNDLE,
          [MAP]: validMap({
            sources: ["../src/server.ts", "../src/other.ts"],
            sourcesContent: ["export function start() {}\n", "  "],
          }),
        }),
      ),
    ).toThrow("dist/server.mjs.map is missing source content for a repository source");
  });
});
