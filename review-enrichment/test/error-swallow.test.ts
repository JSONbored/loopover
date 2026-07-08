// Units for the error-swallow analyzer (#2014). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectErrorSwallow,
  scanErrorSwallow,
  scanPatchForErrorSwallow,
} from "../dist/analyzers/error-swallow.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectErrorSwallow: flags empty catches and return-null handlers", () => {
  assert.equal(detectErrorSwallow("try { f(); } catch (e) {}"), "empty-catch");
  assert.equal(detectErrorSwallow("try { f(); } catch {}"), "empty-catch");
  assert.equal(detectErrorSwallow("try { f(); } catch (e) { return null; }"), "return-null");
  assert.equal(detectErrorSwallow("except ValueError: pass"), "empty-catch");
  assert.equal(detectErrorSwallow("except ValueError as err: pass"), "unused-binding");
});

test("detectErrorSwallow: does not flag catches that log, rethrow, or use the binding", () => {
  assert.equal(detectErrorSwallow("try { f(); } catch (e) { console.error(e); }"), null);
  assert.equal(detectErrorSwallow("try { f(); } catch (e) { throw e; }"), null);
  assert.equal(detectErrorSwallow("try { f(); } catch (e) { cleanup(e); }"), null);
  assert.equal(detectErrorSwallow("try { f(); } catch ($err) { handle($err); }"), null);
});

test("detectErrorSwallow: brace-balances nested blocks on one line", () => {
  assert.equal(detectErrorSwallow("try { f(); } catch (e) { if (x) {} handle(e); }"), null);
});

test("detectErrorSwallow: flags unused bindings on single-line catches", () => {
  assert.equal(detectErrorSwallow("try { f(); } catch (err) { cleanup(); }"), "unused-binding");
});

test("scanPatchForErrorSwallow: flags added lines with correct locations", () => {
  const findings = scanPatchForErrorSwallow(
    "src/worker.ts",
    patchOf([
      "export async function run() {",
      "  try {",
      "    await load();",
      "  } catch (e) {}",
      "}",
    ]),
  );
  assert.deepEqual(findings, [{ file: "src/worker.ts", line: 4, kind: "empty-catch" }]);
});

test("scanPatchForErrorSwallow: supports multi-line catch blocks on added lines", () => {
  const patch = [
    "@@ -1,0 +1,5 @@",
    "+try {",
    "+  await load();",
    "+} catch (err) {",
    "+  return null;",
    "+}",
  ].join("\n");
  assert.deepEqual(scanPatchForErrorSwallow("src/worker.ts", patch), [
    { file: "src/worker.ts", line: 3, kind: "return-null" },
  ]);
});

test("scanPatchForErrorSwallow: skips test files", () => {
  assert.deepEqual(
    scanPatchForErrorSwallow("src/worker.test.ts", patchOf(["catch (e) {}"])),
    [],
  );
});

test("scanPatchForErrorSwallow: respects the findings cap", () => {
  const lines = Array.from({ length: 30 }, () => "catch (e) {}");
  assert.equal(scanPatchForErrorSwallow("src/a.ts", patchOf(lines), { maxFindings: 3 }).length, 3);
});

test("scanErrorSwallow: aggregates across files and renders a public-safe brief", async () => {
  const findings = await scanErrorSwallow({
    files: [
      { path: "src/a.ts", patch: patchOf(["catch (e) {}"]) },
      { path: "lib/b.py", patch: patchOf(["except RuntimeError: pass"]) },
    ],
  });
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, kind: "empty-catch" },
    { file: "lib/b.py", line: 1, kind: "empty-catch" },
  ]);

  const { promptSection } = renderBrief({ errorSwallow: findings });
  assert.match(promptSection, /Swallowed errors/);
  assert.match(promptSection, /src\/a\.ts:1/);
  assert.doesNotMatch(promptSection, /catch \(e\)/);
});

test("detectErrorSwallow: flags Go if-err checks that swallow the error", () => {
  assert.equal(detectErrorSwallow("if err != nil {}"), "empty-catch");
  assert.equal(detectErrorSwallow("if err != nil { return }"), "unused-binding");
  assert.equal(detectErrorSwallow("if err != nil { return nil }"), "return-null");
  assert.equal(detectErrorSwallow("if writeErr != nil { return nil }"), "return-null");
});

test("detectErrorSwallow: does not flag Go if-err checks that propagate, log, or panic", () => {
  assert.equal(detectErrorSwallow("if err != nil { return err }"), null);
  assert.equal(detectErrorSwallow("if err != nil { return fmt.Errorf(\"x: %w\", err) }"), null);
  assert.equal(detectErrorSwallow("if err != nil { log.Println(err) }"), null);
  assert.equal(detectErrorSwallow("if err != nil { panic(err) }"), null);
});

test("detectErrorSwallow: does not mistake an unrelated nil-pointer check for error handling", () => {
  assert.equal(detectErrorSwallow("if node != nil { return defaultNode }"), null);
});

test("detectErrorSwallow: recognizes the Go if-with-initializer form", () => {
  assert.equal(detectErrorSwallow("if err := doStuff(); err != nil { return }"), "unused-binding");
  assert.equal(detectErrorSwallow("if err := doStuff(); err != nil { return err }"), null);
});

test("detectErrorSwallow: flags a bare Python except naming no exception type, regardless of body", () => {
  assert.equal(detectErrorSwallow("except:"), "bare-except");
  assert.equal(detectErrorSwallow("  except:  "), "bare-except");
  assert.equal(detectErrorSwallow("except:  # noqa"), "bare-except");
});

test("detectErrorSwallow: does not flag a Python except naming a real exception type", () => {
  assert.equal(detectErrorSwallow("except Exception:"), null);
  assert.equal(detectErrorSwallow("except (TypeError, ValueError):"), null);
});

test("scanPatchForErrorSwallow: supports multi-line Go if-err blocks on added lines", () => {
  const patch = [
    "@@ -1,0 +1,4 @@",
    "+resp, err := doStuff()",
    "+if err != nil {",
    "+  return",
    "+}",
  ].join("\n");
  assert.deepEqual(scanPatchForErrorSwallow("main.go", patch), [
    { file: "main.go", line: 2, kind: "unused-binding" },
  ]);
});

test("scanPatchForErrorSwallow: flags a bare except on an added Python line", () => {
  const findings = scanPatchForErrorSwallow("lib/b.py", patchOf(["except:", "    handle()"]));
  assert.deepEqual(findings, [{ file: "lib/b.py", line: 1, kind: "bare-except" }]);
});

test("scanPatchForErrorSwallow: skips Go test files", () => {
  assert.deepEqual(
    scanPatchForErrorSwallow("main_test.go", patchOf(["if err != nil {}"])),
    [],
  );
});
