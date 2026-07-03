import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The MCP's local score-preview script inlines its own isTestFile/isCodeFile (it ships in the standalone Node
// bin package and can't import from src/). They must mirror the server's isTestPath/isCodeFile, or a miner's
// LOCAL preview classifies files differently than the gate would. This spawns the real script and checks the
// token classification, which is where the drift would surface.
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "../../packages/gittensory-mcp/scripts");
const scriptMjs = join(scriptsDir, "gittensor-score-preview.mjs");
const scriptPy = join(scriptsDir, "gittensor-score-preview.py");

const SAMPLE = [
  { path: "src/loader.mts", additions: 10, deletions: 0 }, // module-ext source — was non-code before the fix
  { path: "e2e/login.cy.ts", additions: 5, deletions: 0 }, // Cypress test — was counted as source before
  { path: "src/test_api.py", additions: 3, deletions: 0 }, // pytest test_*.py prefix — was counted as source before
  { path: "__snapshots__/Card.tsx.snap", additions: 4, deletions: 0 }, // ROOT-LEVEL snapshot dir — segment-aware match
];
const SAMPLE_TEST_LINES = 5 + 3 + 4; // cy + pytest + root-level snapshot

function runPreview(changedFiles: Array<{ path: string; additions: number; deletions: number }>): { sourceTokenScore: number; testTokenScore: number; nonCodeTokenScore: number } {
  const res = spawnSync(process.execPath, [scriptMjs], { input: JSON.stringify({ changedFiles }), encoding: "utf8" });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

function findPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}

describe("gittensor-score-preview.mjs classifier parity with the server", () => {
  it("counts module-ext source as code and pytest-prefix/Cypress files as tests, matching isTestPath/isCodeFile", () => {
    const out = runPreview([...SAMPLE, { path: "app/FooTests.java", additions: 7, deletions: 0 }]); // + JVM test control
    expect(out.sourceTokenScore).toBe(10); // only src/loader.mts is source now
    expect(out.testTokenScore).toBe(SAMPLE_TEST_LINES + 7); // cy + pytest + root snapshot + JVM tests
    expect(out.nonCodeTokenScore).toBe(0); // the .mts is no longer misfiled as non-code
  });

  it("the .py fallback classifier agrees with the .mjs (skipped when no python is available)", () => {
    // metadata_fallback runs when GITTENSOR_ROOT is unset; its source-extension tuple must also carry the module
    // extensions so a .mts is counted as source, not non-code.
    const python = findPython();
    if (!python) return; // environment has no python — the .mjs test above covers the shared intent
    const env = { ...process.env };
    delete env.GITTENSOR_ROOT;
    const res = spawnSync(python, [scriptPy], { input: JSON.stringify({ changedFiles: SAMPLE }), encoding: "utf8", env });
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.sourceTokenScore).toBe(10);
    expect(out.testTokenScore).toBe(SAMPLE_TEST_LINES);
    expect(out.nonCodeTokenScore).toBe(0);
  });

  it("does not misclassify a *.test.mjs.map source-map as a test (extension anchored to end-of-path, matching the server)", () => {
    // A substring match on ".test.mjs" wrongly flagged non-tests like dist/widget.test.mjs.map; the rule must be
    // end-anchored like isTestPath. It's a source-map — neither test nor code — so it counts as non-code.
    const files = [{ path: "dist/widget.test.mjs.map", additions: 2, deletions: 0 }];
    const mjs = runPreview(files);
    expect(mjs.testTokenScore).toBe(0);
    expect(mjs.nonCodeTokenScore).toBe(2);

    const python = findPython();
    if (!python) return;
    const env = { ...process.env };
    delete env.GITTENSOR_ROOT;
    const res = spawnSync(python, [scriptPy], { input: JSON.stringify({ changedFiles: files }), encoding: "utf8", env });
    expect(res.status, res.stderr).toBe(0);
    const py = JSON.parse(res.stdout);
    expect(py.testTokenScore).toBe(0);
    expect(py.nonCodeTokenScore).toBe(2);
  });
});
