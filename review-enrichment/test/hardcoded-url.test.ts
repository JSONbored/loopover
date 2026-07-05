// Units for the hardcoded-URL analyzer (#2027). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHardcodedUrl,
  scanHardcodedUrl,
  scanPatchForHardcodedUrl,
} from "../dist/analyzers/hardcoded-url.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectHardcodedUrl: flags absolute HTTP(S) URLs and IP:port endpoints", () => {
  assert.deepEqual(detectHardcodedUrl(`const base = "https://api.prod.example.org/v1";`), {
    kind: "http-url",
    host: "api.prod.example.org",
  });
  assert.deepEqual(detectHardcodedUrl("await fetch('http://10.0.0.5:8080/health');"), {
    kind: "http-url",
    host: "10.0.0.5",
  });
  assert.deepEqual(detectHardcodedUrl("db.connect('192.168.0.12:5432')"), {
    kind: "ip-endpoint",
    host: "192.168.0.12",
  });
});

test("detectHardcodedUrl: allowlists localhost, 127.0.0.1, and example.com", () => {
  assert.equal(detectHardcodedUrl("fetch('http://localhost:3000')"), null);
  assert.equal(detectHardcodedUrl("fetch('http://127.0.0.1:8080')"), null);
  assert.equal(detectHardcodedUrl("fetch('https://api.example.com/v1')"), null);
  assert.equal(detectHardcodedUrl("fetch('https://docs.staging.example.com')"), null);
});

test("detectHardcodedUrl: skips comment and import lines", () => {
  assert.equal(detectHardcodedUrl("// docs: https://evil.example.net/guide"), null);
  assert.equal(detectHardcodedUrl("import config from 'https://cdn.example.net/schema.json'"), null);
  assert.equal(detectHardcodedUrl("# see https://evil.example.net"), null);
});

test("scanPatchForHardcodedUrl: flags added lines with correct locations", () => {
  const findings = scanPatchForHardcodedUrl(
    "src/client.ts",
    patchOf([
      "export async function load() {",
      "  return fetch('https://billing.internal.example/v1');",
      "}",
    ]),
  );
  assert.deepEqual(findings, [
    { file: "src/client.ts", line: 2, kind: "http-url", host: "billing.internal.example" },
  ]);
});

test("scanPatchForHardcodedUrl: skips test and config files", () => {
  assert.deepEqual(
    scanPatchForHardcodedUrl("src/widget.test.ts", patchOf(["fetch('https://evil.example.net')"])),
    [],
  );
  assert.deepEqual(
    scanPatchForHardcodedUrl("config/settings.yml", patchOf(["url: https://evil.example.net"])),
    [],
  );
});

test("scanPatchForHardcodedUrl: respects the findings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `fetch('https://host${i}.example.net');`);
  assert.equal(scanPatchForHardcodedUrl("src/a.ts", patchOf(lines), { maxFindings: 3 }).length, 3);
});

test("scanHardcodedUrl: aggregates across files and renders in the brief", async () => {
  const findings = await scanHardcodedUrl({
    files: [
      { path: "src/a.ts", patch: patchOf(["fetch('https://api.evil.example.net');"]) },
      { path: "lib/db.py", patch: patchOf(["connect('10.1.2.3:5432')"]) },
    ],
  });
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, kind: "http-url", host: "api.evil.example.net" },
    { file: "lib/db.py", line: 1, kind: "ip-endpoint", host: "10.1.2.3" },
  ]);

  const { promptSection } = renderBrief({ hardcodedUrl: findings });
  assert.match(promptSection, /Hardcoded URLs\/endpoints/);
  assert.match(promptSection, /src\/a\.ts:1/);
  assert.match(promptSection, /lib\/db\.py:1/);
});
