import { describe, expect, it } from "vitest";

// The helper ships in the MCP package's lib/ (the bin auto-runs on import, so it cannot be imported);
// mirror the local-branch.test.ts pattern of dynamically importing the packaged .js module.
async function loadFormatTable() {
  return (await import("../../packages/loopover-mcp/lib/format-table.js")).formatTable;
}

describe("formatTable", () => {
  it("aligns columns inferred from an array of row objects", async () => {
    const formatTable = await loadFormatTable();
    const table = formatTable([
      { name: "a", count: 1 },
      { name: "bbbb", count: 22 },
    ]);
    expect(table.split("\n")).toEqual(["name  count", "a     1", "bbbb  22"]);
  });

  it("honours explicit headers, labels, and right alignment", async () => {
    const formatTable = await loadFormatTable();
    const table = formatTable({
      headers: [
        { key: "action", label: "Action" },
        { key: "priority", label: "Priority", align: "right" },
      ],
      rows: [
        { action: "prepare_pr_packet", priority: 12 },
        { action: "add_tests", priority: 3 },
      ],
    });
    const lines = table.split("\n");
    expect(lines[0]).toBe("Action             Priority");
    // Right alignment pins the numbers' trailing digits to the same column.
    expect(lines[1]).toBe("prepare_pr_packet        12");
    expect(lines[2]).toBe("add_tests                 3");
  });

  it("accepts positional array rows with string headers and a custom gap", async () => {
    const formatTable = await loadFormatTable();
    const table = formatTable({ headers: ["A", "B", "C"], rows: [["x", "yy", "zzz"]] }, { gap: 1 });
    expect(table.split("\n")).toEqual(["A B  C", "x yy zzz"]);
  });

  it("renders missing keys as blank cells without leaking undefined", async () => {
    const formatTable = await loadFormatTable();
    const table = formatTable([{ a: "one", b: "two" }, { a: "three" }]);
    expect(table.split("\n")).toEqual(["a      b", "one    two", "three"]);
  });

  it("returns a header-only table when there are no rows", async () => {
    const formatTable = await loadFormatTable();
    expect(formatTable({ headers: ["Score blocker"], rows: [] })).toBe("Score blocker");
  });

  it("returns an empty string when no columns can be determined", async () => {
    const formatTable = await loadFormatTable();
    expect(formatTable([])).toBe("");
    expect(formatTable({ headers: [], rows: [{ a: 1 }] })).toBe("");
  });
});
