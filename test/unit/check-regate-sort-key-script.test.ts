import { describe, expect, it } from "vitest";
import { findRegateSortKeyViolations } from "../../scripts/check-regate-sort-key";

/** Simulates a tree without touching the real one. Mirrors check-import-specifiers-script.test.ts's helper. */
function fakeFiles(byFile: Record<string, string>) {
  const files = Object.keys(byFile);
  return {
    listSourceFiles: (root: string) => files.filter((f) => f.startsWith(`${root}/`)),
    readFile: (file: string) => byFile[file] ?? "",
  };
}

// #9499: jobClaimSortKey sorts agent-regate-pr jobs by the PR's own createdAt ascending — the one real
// oldest-first mechanism the queue has. A producer omitting prCreatedAt falls back to
// LEGACY_AGENT_REGATE_SORT_BASE_MS + prNumber (~9.5e11), which sorts AHEAD of every genuinely older 2026 PR
// (~1.78e12). So an omission does not degrade the ordering, it INVERTS it — silently, for that producer only.
describe("check-regate-sort-key script", () => {
  it("REGRESSION: flags a producer that omits prCreatedAt", () => {
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map(),
      ...fakeFiles({
        "src/queue/thing.ts": `await env.JOBS.send({\n  type: "agent-regate-pr",\n  deliveryId,\n  repoFullName,\n  prNumber,\n});\n`,
      }),
    });
    expect(violations).toEqual([{ file: "src/queue/thing.ts", line: 2, snippet: 'type: "agent-regate-pr",' }]);
  });

  it("INVARIANT: a producer that passes prCreatedAt is clean, in either spread or plain form", () => {
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map(),
      ...fakeFiles({
        "src/a.ts": `send({\n  type: "agent-regate-pr",\n  prNumber,\n  ...(pr.createdAt ? { prCreatedAt: pr.createdAt } : {}),\n});\n`,
        "src/b.ts": `send({\n  type: "agent-regate-pr",\n  prNumber,\n  prCreatedAt,\n});\n`,
      }),
    });
    expect(violations).toEqual([]);
  });

  // The false negative this check actually had while being written: a fixed-line window let one producer's
  // field satisfy the scan for a NEIGHBOURING producer's omission, so removing a field was not caught. The
  // scan is bounded by the literal's own closing brace precisely so each producer is judged on its own.
  it("REGRESSION: a NEIGHBOURING producer's prCreatedAt does not mask this one's omission", () => {
    const source = [
      "const good = {",
      '  type: "agent-regate-pr",',
      "  prNumber,",
      "  ...(pr.createdAt ? { prCreatedAt: pr.createdAt } : {}),",
      "};",
      "const bad = {",
      '  type: "agent-regate-pr",',
      "  prNumber,",
      "};",
      "",
    ].join("\n");
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map(),
      ...fakeFiles({ "src/two.ts": source }),
    });
    expect(violations).toEqual([{ file: "src/two.ts", line: 7, snippet: 'type: "agent-regate-pr",' }]);
  });

  it("INVARIANT: the reverse order also holds — a good producer AFTER a bad one does not rescue it", () => {
    const source = [
      "const bad = {",
      '  type: "agent-regate-pr",',
      "  prNumber,",
      "};",
      "const good = {",
      '  type: "agent-regate-pr",',
      "  prNumber,",
      "  prCreatedAt,",
      "};",
      "",
    ].join("\n");
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map(),
      ...fakeFiles({ "src/two.ts": source }),
    });
    expect(violations).toEqual([{ file: "src/two.ts", line: 2, snippet: 'type: "agent-regate-pr",' }]);
  });

  it("INVARIANT: an allowlisted deliberate omission is not flagged, and the allowlist is matched by MARKER not line number", () => {
    // Keyed on a distinctive deliveryId substring so the entry survives ordinary line churn — an
    // allowlist keyed on position would silently stop applying (or start applying to the wrong producer)
    // the first time someone edited the file above it.
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map([["src/api/routes.ts:manual-regate:", "operator-triggered, jumps the queue on purpose"]]),
      ...fakeFiles({
        "src/api/routes.ts": `const message = {\n  type: "agent-regate-pr",\n  deliveryId: \`manual-regate:\${id}\`,\n  prNumber,\n};\n`,
      }),
    });
    expect(violations).toEqual([]);
  });

  it("INVARIANT: the allowlist is scoped to its own FILE — the same marker elsewhere is still flagged", () => {
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map([["src/api/routes.ts:manual-regate:", "reason"]]),
      ...fakeFiles({
        "src/queue/copycat.ts": `const message = {\n  type: "agent-regate-pr",\n  deliveryId: \`manual-regate:\${id}\`,\n  prNumber,\n};\n`,
      }),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/queue/copycat.ts");
  });

  it("INVARIANT: a file with no regate producer at all yields nothing", () => {
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map(),
      ...fakeFiles({ "src/unrelated.ts": `send({ type: "recapture-preview", prNumber });\n` }),
    });
    expect(violations).toEqual([]);
  });

  it("reports violations sorted by file then line, so failure output is stable", () => {
    const bad = `send({\n  type: "agent-regate-pr",\n  prNumber,\n});\n`;
    const violations = findRegateSortKeyViolations({
      roots: ["src"],
      allowedOmissions: new Map(),
      ...fakeFiles({ "src/z.ts": bad, "src/a.ts": bad }),
    });
    expect(violations.map((violation) => violation.file)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("the REAL repo tree is clean — this check runs in CI and must stay green", () => {
    expect(findRegateSortKeyViolations()).toEqual([]);
  });
});
