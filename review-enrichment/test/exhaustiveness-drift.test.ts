// Units for the exhaustiveness-drift analyzer (#2028). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAddedTypeMembers,
  extractEnumMembers,
  extractUnionMembers,
  findExhaustivenessGap,
  scanExhaustivenessDrift,
} from "../dist/analyzers/exhaustiveness-drift.js";
import { renderBrief } from "../dist/render.js";

const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  headSha: "abc123",
  files,
  ...extra,
});

const HEAD_UNCOVERED = [
  "export enum Status {",
  "  Active,",
  "  Pending,",
  "  Archived,",
  "}",
  "",
  "export function dispatch(status: Status) {",
  "  switch (status) {",
  "    case Status.Active:",
  "    case Status.Pending:",
  "      break;",
  "  }",
  "}",
].join("\n");

const PATCH_ADD_ARCHIVED = [
  "@@ -1,4 +1,5 @@",
  " export enum Status {",
  "   Active,",
  "   Pending,",
  "+  Archived,",
  " }",
].join("\n");

test("parseAddedTypeMembers: collects added enum members with line numbers", () => {
  assert.deepEqual(parseAddedTypeMembers(PATCH_ADD_ARCHIVED), [
    { unionName: "Status", addedMember: "Archived", line: 4, kind: "enum" },
  ]);
});

test("findExhaustivenessGap: flags a switch that covered all old enum members but omits the new one", () => {
  const oldMembers = new Set(["Active", "Pending"]);
  const gap = findExhaustivenessGap(HEAD_UNCOVERED, "enum", "Status", oldMembers, "Archived");
  assert.deepEqual(gap, { line: 8 });
});

test("findExhaustivenessGap: does not flag when the switch already covers the new member", () => {
  const covered = HEAD_UNCOVERED.replace(
    "    case Status.Pending:",
    "    case Status.Pending:\n    case Status.Archived:",
  );
  const oldMembers = new Set(["Active", "Pending"]);
  assert.equal(findExhaustivenessGap(covered, "enum", "Status", oldMembers, "Archived"), null);
});

test("extractUnionMembers: reads string-literal union members from a type alias", () => {
  const src = 'export type Role = "admin" | "user";';
  assert.deepEqual([...extractUnionMembers(src, "Role")!], ["admin", "user"]);
});

test("scanExhaustivenessDrift: end-to-end flags an uncovered added enum member and renders it", async () => {
  const fetchFn = async (url) => {
    if (url.includes("/contents/")) return new Response(HEAD_UNCOVERED, { status: 200 });
    return new Response("", { status: 404 });
  };
  const findings = await scanExhaustivenessDrift(
    req([{ path: "src/status.ts", status: "modified", patch: PATCH_ADD_ARCHIVED }]),
    fetchFn,
  );
  assert.deepEqual(findings, [
    {
      file: "src/status.ts",
      line: 4,
      unionName: "Status",
      addedMember: "Archived",
    },
  ]);
  const brief = renderBrief({ exhaustiveness: findings }).promptSection;
  assert.match(brief, /exhaustiveness drift/i);
  assert.match(brief, /Archived/);
});

test("scanExhaustivenessDrift: does not flag when the switch is updated in the same file", async () => {
  const head = HEAD_UNCOVERED.replace(
    "    case Status.Pending:",
    "    case Status.Pending:\n    case Status.Archived:",
  );
  const patch = [
    "@@ -1,4 +1,5 @@",
    " export enum Status {",
    "   Active,",
    "   Pending,",
    "+  Archived,",
    " }",
    "@@ -10,3 +11,4 @@",
    "     case Status.Active:",
    "     case Status.Pending:",
    "+    case Status.Archived:",
    "       break;",
  ].join("\n");
  const fetchFn = async (url) => {
    if (url.includes("/contents/")) return new Response(head, { status: 200 });
    return new Response("", { status: 404 });
  };
  const findings = await scanExhaustivenessDrift(
    req([{ path: "src/status.ts", status: "modified", patch }]),
    fetchFn,
  );
  assert.deepEqual(findings, []);
});

test("scanExhaustivenessDrift: enforces the maxFetches cap", async () => {
  const patch = ["@@ -0,0 +1,2 @@", "+export enum E {", "+  A,", "+}"].join("\n");
  const files = Array.from({ length: 12 }, (_, i) => ({
    path: `src/file${i}.ts`,
    status: "added",
    patch: patch.replace("E", `E${i}`).replace("A", `A${i}`),
  }));
  let fetches = 0;
  const fetchFn = async (url) => {
    if (url.includes("/contents/")) {
      fetches += 1;
      return new Response("export enum E0 { A0 }\n", { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  await scanExhaustivenessDrift(req(files), fetchFn);
  assert.equal(fetches, 10);
});

test("scanExhaustivenessDrift: returns no findings without a GitHub token", async () => {
  const findings = await scanExhaustivenessDrift(
    req([{ path: "src/status.ts", status: "modified", patch: PATCH_ADD_ARCHIVED }], {
      githubToken: undefined,
    }),
    async () => new Response("", { status: 500 }),
  );
  assert.deepEqual(findings, []);
});
