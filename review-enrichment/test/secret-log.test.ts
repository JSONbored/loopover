// Units for the secrets/PII-in-logs analyzer (#1507). Own file so concurrent analyzer PRs don't collide.
// Pure compute, no network. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeOnly,
  detectSecretLog,
  scanPatchForSecretLog,
  scanSecretLog,
} from "../dist/analyzers/secret-log.js";

test("detectSecretLog flags a secret referenced as code in a console.log sink", () => {
  assert.deepEqual(detectSecretLog("console.log(req.headers.authorization)"), {
    sink: "console.log",
    category: "secret",
  });
});

test("detectSecretLog flags PII and request-object dumps", () => {
  assert.deepEqual(detectSecretLog("logger.info(`ssn=${user.ssn}`)"), {
    sink: "logger.info",
    category: "pii",
  });
  assert.deepEqual(detectSecretLog("console.error(req.body)"), {
    sink: "console.error",
    category: "request-object",
  });
});

test("detectSecretLog does not flag string-literal log messages", () => {
  // The sensitive word lives only inside a string message, not as code, so it must not trigger.
  assert.equal(
    detectSecretLog('console.log("password reset email sent")'),
    null,
  );
  assert.equal(detectSecretLog("console.log('request received')"), null);
});

test("detectSecretLog flags console.dir dumping a request object", () => {
  // Regression for the sink list missing `console.dir`, which prints an object straight to stdout.
  assert.deepEqual(detectSecretLog("console.dir(req.headers)"), {
    sink: "console.dir",
    category: "request-object",
  });
});

test("detectSecretLog flags console.table dumping sensitive rows", () => {
  // Regression for the sink list missing `console.table`, which dumps a collection to stdout.
  assert.deepEqual(
    detectSecretLog("console.table(users.map((u) => u.password))"),
    {
      sink: "console.table",
      category: "secret",
    },
  );
});

test("detectSecretLog ignores console.dir/table on innocuous data", () => {
  // The new sinks must stay precision-first: no sensitive token as code ⇒ no finding.
  assert.equal(detectSecretLog("console.dir(config.timeoutMs)"), null);
  assert.equal(detectSecretLog("console.table(rows)"), null);
});

test("codeOnly strips string messages but keeps interpolation bodies as code", () => {
  assert.equal(
    codeOnly('console.log("just a message")').includes("message"),
    false,
  );
  assert.equal(
    codeOnly("console.log(`token=${apiKey}`)").includes("apiKey"),
    true,
  );
});

test("scanPatchForSecretLog cites the added line via the hunk header", () => {
  const patch = [
    "@@ -1,0 +42,2 @@",
    "+console.dir(req.headers)",
    " const untouched = 1;",
  ].join("\n");
  assert.deepEqual(scanPatchForSecretLog("src/app.ts", patch), [
    {
      file: "src/app.ts",
      line: 42,
      sink: "console.dir",
      category: "request-object",
    },
  ]);
});

test("scanPatchForSecretLog ignores context and removed lines", () => {
  const patch = [
    "@@ -1,2 +1,1 @@",
    " console.log(req.headers)",
    "-console.log(req.body)",
  ].join("\n");
  assert.deepEqual(scanPatchForSecretLog("src/app.ts", patch), []);
});

test("scanSecretLog scans every changed file's added lines", async () => {
  const findings = await scanSecretLog({
    files: [
      { path: "a.ts", patch: "@@ -1,0 +1,1 @@\n+console.table(req.body)" },
      {
        path: "b.ts",
        patch: "@@ -1,0 +5,1 @@\n+logger.info(`key=${clientSecret}`)",
      },
    ],
  });
  assert.deepEqual(findings, [
    {
      file: "a.ts",
      line: 1,
      sink: "console.table",
      category: "request-object",
    },
    { file: "b.ts", line: 5, sink: "logger.info", category: "secret" },
  ]);
});
