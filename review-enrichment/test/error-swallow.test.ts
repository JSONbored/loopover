// Units for the error-swallow analyzer (#2014). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. No network — pure, single-line detection. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectErrorSwallow,
  scanPatchForErrorSwallow,
  scanErrorSwallow,
} from "../dist/analyzers/error-swallow.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectErrorSwallow: an empty catch body is flagged (with and without a binding)", () => {
  assert.equal(detectErrorSwallow("try { risky(); } catch (e) {}", "js"), "empty-catch");
  assert.equal(detectErrorSwallow("} catch {}", "js"), "empty-catch");
  assert.equal(detectErrorSwallow("} catch (err) {   }", "js"), "empty-catch");
  // A comment-only body is effectively empty — it too swallows the error.
  assert.equal(detectErrorSwallow("} catch (e) { /* ignore */ }", "js"), "empty-catch");
});

test("detectErrorSwallow: a catch that just returns null/undefined is return-null", () => {
  assert.equal(detectErrorSwallow("} catch (e) { return null; }", "js"), "return-null");
  assert.equal(detectErrorSwallow("} catch (e) { return undefined }", "js"), "return-null");
});

test("detectErrorSwallow: a catch whose body ignores the binding (no rethrow/log/reference) is unused-binding", () => {
  assert.equal(detectErrorSwallow("} catch (e) { cleanup(); }", "js"), "unused-binding");
  assert.equal(detectErrorSwallow("} catch (err) { doStuff(); return false; }", "js"), "unused-binding");
});

test("detectErrorSwallow: a catch that rethrows, logs, or references the binding is NOT flagged", () => {
  assert.equal(detectErrorSwallow("} catch (e) { throw e; }", "js"), null);
  assert.equal(detectErrorSwallow("} catch (e) { console.error(e); }", "js"), null);
  assert.equal(detectErrorSwallow("} catch (e) { logger.warn(e.message); }", "js"), null);
  assert.equal(detectErrorSwallow("} catch (e) { return e; }", "js"), null);
  assert.equal(detectErrorSwallow("} catch (e) { reportError(e); }", "js"), null); // references e
});

test("detectErrorSwallow: a bindingless catch that does real work is not an unused-binding", () => {
  // No binding to ignore, non-empty body — not flagged (only empty-catch/return-null apply without a binding).
  assert.equal(detectErrorSwallow("} catch { cleanup(); }", "js"), null);
});

test("detectErrorSwallow: `catch` inside a string or comment is not matched", () => {
  assert.equal(detectErrorSwallow('const s = "} catch (e) {}";', "js"), null);
  assert.equal(detectErrorSwallow("// } catch (e) {} left as a note", "js"), null);
});

test("detectErrorSwallow: Python `except …: pass` is an empty-catch; a handling except is not", () => {
  assert.equal(detectErrorSwallow("    except ValueError: pass", "py"), "empty-catch");
  assert.equal(detectErrorSwallow("    except: pass", "py"), "empty-catch");
  assert.equal(detectErrorSwallow("    except ValueError: raise", "py"), null);
  assert.equal(detectErrorSwallow("    except ValueError as e: log(e)", "py"), null);
});

test("scanPatchForErrorSwallow: flags kinds on added lines with correct locations; non-JS/Py skipped", () => {
  const findings = scanPatchForErrorSwallow(
    "src/svc.ts",
    patchOf(["function f() {", "  try { a(); } catch (e) {}", "  return 1;", "}"]),
  );
  assert.deepEqual(findings, [{ file: "src/svc.ts", line: 2, kind: "empty-catch" }]);
  assert.deepEqual(scanPatchForErrorSwallow("docs/x.md", patchOf(["} catch (e) {}"])), []);
});

test("scanPatchForErrorSwallow: only ADDED lines are scanned; new-file line numbers stay correct", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " function f() {", // context line 10
    "-  } catch (e) {}", // removed, does not advance
    "+  } catch (e) {}", // new-file line 11
  ].join("\n");
  assert.deepEqual(scanPatchForErrorSwallow("src/a.ts", patch), [
    { file: "src/a.ts", line: 11, kind: "empty-catch" },
  ]);
});

test("scanPatchForErrorSwallow: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, () => "} catch (e) {}");
  assert.equal(scanPatchForErrorSwallow("src/a.ts", patchOf(lines), { maxFindings: 5 }).length, 5);
  assert.deepEqual(scanPatchForErrorSwallow("src/a.ts", patchOf(lines), { maxFindings: 0 }), []);
});

test("scanErrorSwallow: scans every changed file and honors the global cap", async () => {
  const empties = Array.from({ length: 30 }, () => "} catch (e) {}");
  const findings = await scanErrorSwallow({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/a.ts", patch: patchOf(["const ok = true;"]) },
      { path: "src/b.ts", patch: patchOf(empties) },
    ],
  });
  assert.equal(findings.length, 25);
  assert.ok(findings.every((f) => f.file === "src/b.ts"));
});

test("scanErrorSwallow: no files yields no findings", async () => {
  assert.deepEqual(await scanErrorSwallow({ repoFullName: "octo/repo", prNumber: 1 }), []);
});
