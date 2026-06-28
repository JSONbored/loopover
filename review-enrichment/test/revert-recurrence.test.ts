import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectRevertLanguage,
  isSymmetricChurn,
  scanRevertRecurrence,
  summarizeFileChurn,
} from "../src/analyzers/revert-recurrence.ts";

describe("revert-recurrence analyzer", () => {
  it("detects explicit revert titles and body references", () => {
    const titleFindings = detectRevertLanguage(
      'Revert "feat: add cache layer"',
      undefined,
    );
    assert.equal(titleFindings[0]?.kind, "explicit-revert");
    assert.equal(titleFindings[0]?.confidence, "high");
    assert.match(titleFindings[0]!.detail, /Revert/i);

    const bodyFindings = detectRevertLanguage(
      "fix: patch",
      "This reverts commit abc123 from PR #42",
    );
    assert.equal(bodyFindings[0]?.kind, "explicit-revert");
  });

  it("flags rollback language separately from explicit revert titles", () => {
    const findings = detectRevertLanguage("Rollback auth middleware change", "");
    assert.ok(findings.some((f) => f.kind === "rollback-language"));
  });

  it("summarizes per-file churn from patches", () => {
    const churn = summarizeFileChurn([
      {
        path: "src/a.ts",
        patch: [
          "@@",
          "+line1",
          "+line2",
          "+line3",
          "-old1",
          "-old2",
          "-old3",
          "-old4",
          "-old5",
          "-old6",
          "-old7",
          "-old8",
        ].join("\n"),
      },
    ]);
    assert.equal(churn.length, 1);
    assert.deepEqual(churn[0], {
      path: "src/a.ts",
      additions: 3,
      deletions: 8,
    });
  });

  it("recognizes symmetric churn shapes", () => {
    assert.equal(
      isSymmetricChurn({ path: "a.ts", additions: 2, deletions: 20 }),
      true,
    );
    assert.equal(
      isSymmetricChurn({ path: "a.ts", additions: 3, deletions: 3 }),
      false,
    );
    assert.equal(
      isSymmetricChurn({ path: "a.ts", additions: 1, deletions: 1 }),
      false,
    );
  });

  it("scanRevertRecurrence combines language and churn signals", async () => {
    const findings = await scanRevertRecurrence({
      repoFullName: "o/r",
      prNumber: 1,
      title: "Revert risky refactor",
      body: "",
      files: [
        {
          path: "src/core.ts",
          patch: [
            "@@ -1,12 +1,2 @@",
            "-export function old() {}",
            "-export function old2() {}",
            "-export function old3() {}",
            "-export function old4() {}",
            "-export function old5() {}",
            "-export function old6() {}",
            "-export function old7() {}",
            "-export function old8() {}",
            "-export function old9() {}",
            "-export function old10() {}",
            "-export function old11() {}",
            "+export function newOnly() {}",
          ].join("\n"),
        },
      ],
    });
    assert.ok(findings.some((f) => f.kind === "explicit-revert"));
    assert.ok(findings.some((f) => f.kind === "symmetric-churn"));
    const churn = findings.find((f) => f.kind === "symmetric-churn");
    assert.ok(churn?.files?.includes("src/core.ts"));
  });
});
