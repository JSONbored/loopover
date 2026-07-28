import { describe, expect, it } from "vitest";
import { findDeadSourceFiles } from "../../scripts/check-dead-source-files";

/** Simulates a tree without touching the real one: every injectable seam the checker exposes, driven off one
 *  `path -> contents` map. Mirrors check-import-specifiers-script.test.ts's own `fakeFiles` helper. */
function fakeTree(byFile: Record<string, string>) {
  const files = Object.keys(byFile);
  return {
    listSourceFiles: (root: string, pattern: RegExp) => files.filter((f) => f.startsWith(`${root}/`) && pattern.test(f)),
    listTestFiles: (root: string, pattern: RegExp) => files.filter((f) => f.startsWith(`${root}/`) && pattern.test(f)),
    readFile: (file: string) => byFile[file] ?? "",
    fileExists: (file: string) => file in byFile,
  };
}

// #9492: issue-rag-wire.ts had ZERO production importers — both real consumers imported the engine module it
// re-exported, directly, and only its own test imported the wire. Coverage reported it green the whole time,
// because a dead module's own test exercises it perfectly well. Reachability is the only signal that catches
// this, and commit 39cc9583c shows the class has bitten before.
describe("check-dead-source-files script", () => {
  it("REGRESSION: flags a src module whose ONLY importer is its own test — the issue-rag-wire shape", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({
        "src/review/thing-wire.ts": 'export { thing } from "../../packages/engine/src/thing";',
        "test/unit/thing-wire.test.ts": 'import { thing } from "../../src/review/thing-wire";',
      }),
    });
    expect(violations).toEqual([{ file: "src/review/thing-wire.ts", reason: "only its own test imports it — no production consumer" }]);
  });

  it("REGRESSION: flags a src module with no importer at all, and says so distinctly", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({ "src/review/orphan.ts": "export const x = 1;" }),
    });
    expect(violations).toEqual([{ file: "src/review/orphan.ts", reason: "no importer at all (including its own test)" }]);
  });

  it("INVARIANT: one production importer is enough — a module imported by sibling source is never flagged", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({
        "src/review/thing.ts": "export const thing = 1;",
        "src/review/consumer.ts": 'import { thing } from "./thing";',
        "test/unit/thing.test.ts": 'import { thing } from "../../src/review/thing";',
      }),
    });
    // Asserted on the file under test, not on global emptiness: `consumer.ts` has no importer of its own in
    // this minimal fixture and is correctly flagged — that is the checker working, not a false positive.
    expect(violations.map((violation) => violation.file)).not.toContain("src/review/thing.ts");
  });

  it("INVARIANT: a test that is NOT the module's own test counts as a real importer — only the same-named test is discounted", () => {
    // A shared helper imported by many suites is alive even with no src/** importer; discounting every test
    // would flag it. Only `<basename>.test.ts` is treated as the module's own.
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({
        "src/review/helper.ts": "export const help = 1;",
        "test/unit/something-else.test.ts": 'import { help } from "../../src/review/helper";',
      }),
    });
    expect(violations).toEqual([]);
  });

  it("INVARIANT: a scripts/** CLI counts as a production importer — the real check-migrations/draft-issue shape", () => {
    const tree = fakeTree({
      "src/db/extraction.ts": "export const extract = 1;",
      "scripts/check-migrations.ts": 'import { extract } from "../src/db/extraction";',
    });
    expect(findDeadSourceFiles({ importerRoots: ["scripts"], ...tree })).toEqual([]);
    // ...and with scripts NOT scanned, the same tree reports it dead — pinning that the root is what saves it.
    expect(findDeadSourceFiles({ importerRoots: [], ...tree })).toEqual([
      { file: "src/db/extraction.ts", reason: "no importer at all (including its own test)" },
    ]);
  });

  it("INVARIANT: declared entry points are never flagged, however unreachable", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({ "src/index.ts": "export default {};", "src/server.ts": "export const serve = 1;" }),
    });
    expect(violations).toEqual([]);
  });

  it("INVARIANT: resolves a directory specifier through its index.ts, and an extensioned specifier through either zone's form", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({
        "src/lane/index.ts": "export const lane = 1;",
        "src/lane/part.ts": "export const part = 1;",
        // `./lane` (directory -> index.ts), and `.js`/`.ts`-suffixed forms, all resolve to real files.
        "src/consumer.ts": 'import { lane } from "./lane";\nimport { part } from "./lane/part.js";',
      }),
    });
    const dead = violations.map((violation) => violation.file);
    expect(dead).not.toContain("src/lane/index.ts"); // reached via the bare directory specifier
    expect(dead).not.toContain("src/lane/part.ts"); // reached via the `.js`-suffixed specifier
  });

  it("INVARIANT: a specifier reaching OUTSIDE src/** is ignored rather than miscounted as an importer", () => {
    // The checker only answers reachability WITHIN src/**; an engine import must neither crash it nor
    // accidentally mark some unrelated src file as imported.
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({
        "src/review/orphan.ts": "export const x = 1;",
        "src/review/consumer.ts": 'import { thing } from "../../packages/loopover-engine/src/thing";',
        "test/unit/consumer.test.ts": 'import { c } from "../../src/review/consumer";',
      }),
    });
    // The engine specifier neither crashes resolution nor marks anything in src/** as imported: the orphan
    // is still reported, and consumer.ts is reported too (its only importer IS its own test).
    expect(violations).toEqual([
      { file: "src/review/consumer.ts", reason: "only its own test imports it — no production consumer" },
      { file: "src/review/orphan.ts", reason: "no importer at all (including its own test)" },
    ]);
  });

  it("INVARIANT: ambient .d.ts files are not scanned as dead source", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({ "src/worker-configuration.d.ts": "declare const x: 1;" }),
    });
    expect(violations).toEqual([]);
  });

  it("INVARIANT: an export-from re-export counts as an import, so a barrel keeps its members alive", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({
        "src/lane/part.ts": "export const part = 1;",
        "src/lane/barrel.ts": 'export { part } from "./part";',
        "src/consumer.ts": 'import { part } from "./lane/barrel";',
        "test/unit/consumer.test.ts": 'import { c } from "../../src/consumer";',
      }),
    });
    const dead = violations.map((violation) => violation.file);
    expect(dead).not.toContain("src/lane/part.ts"); // kept alive by the barrel's `export ... from`
    expect(dead).not.toContain("src/lane/barrel.ts");
  });

  it("reports violations sorted by path, so the failure output is stable across runs", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      ...fakeTree({ "src/z-last.ts": "export const z = 1;", "src/a-first.ts": "export const a = 1;" }),
    });
    expect(violations.map((violation) => violation.file)).toEqual(["src/a-first.ts", "src/z-last.ts"]);
  });

  // A seam landed ahead of the callers it exists for is legitimate staging, not rot — but only when the
  // exception is STATED. The distinction is the whole value of this check: an unexplained dead file is
  // precisely what it catches, so the escape hatch has to name the issue that ends it.
  it("INVARIANT: a staged-ahead-of-consumers file is exempt, but only when explicitly listed", () => {
    const tree = fakeTree({ "src/openapi/seam.ts": "export const seam = 1;" });
    expect(findDeadSourceFiles({ importerRoots: [], ...tree })).toEqual([
      { file: "src/openapi/seam.ts", reason: "no importer at all (including its own test)" },
    ]);
    expect(
      findDeadSourceFiles({
        importerRoots: [],
        stagedAheadOfConsumers: new Map([["src/openapi/seam.ts", "landed by #X ahead of the migration in #Y"]]),
        ...tree,
      }),
    ).toEqual([]);
  });

  it("INVARIANT: the staged exemption is exact-path, so a sibling in the same directory is still caught", () => {
    const violations = findDeadSourceFiles({
      importerRoots: [],
      stagedAheadOfConsumers: new Map([["src/openapi/seam.ts", "reason"]]),
      ...fakeTree({ "src/openapi/seam.ts": "export const a = 1;", "src/openapi/rot.ts": "export const b = 1;" }),
    });
    expect(violations.map((violation) => violation.file)).toEqual(["src/openapi/rot.ts"]);
  });

  it("the REAL repo tree is clean — this check runs in CI and must stay green", () => {
    expect(findDeadSourceFiles()).toEqual([]);
  });
});
