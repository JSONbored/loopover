import assert from "node:assert/strict";
import test from "node:test";
import { buildGateDispositions } from "../dist/predicted-gate.js";

// #6740: pure reshaper moved into @loopover/engine so the CLI stdio mirror can share it with MCP.
test("buildGateDispositions maps blockers → block and warnings → advisory (blockers first)", () => {
  assert.deepEqual(buildGateDispositions({ blockers: [], warnings: [] }), []);
  assert.deepEqual(
    buildGateDispositions({
      blockers: [{ code: "a", title: "A", detail: "reason a" }],
      warnings: [],
    }),
    [{ rule: "a", status: "block", reason: "reason a" }],
  );
  assert.deepEqual(
    buildGateDispositions({
      blockers: [
        { code: "a", title: "A", detail: "ra" },
        { code: "b", title: "B", detail: "rb" },
      ],
      warnings: [{ code: "w", title: "W", detail: "rw" }],
    }),
    [
      { rule: "a", status: "block", reason: "ra" },
      { rule: "b", status: "block", reason: "rb" },
      { rule: "w", status: "advisory", reason: "rw" },
    ],
  );
});
