import { test } from "node:test";
import assert from "node:assert/strict";

import { scanPatchForIacMisconfig } from "../dist/analyzers/iac-misconfig.js";

test("scanPatchForIacMisconfig flags hostNetwork and compose host network mode", () => {
  const k8s = scanPatchForIacMisconfig(
    "deploy/k8s/app.yaml",
    [
      "@@ -10,0 +10,2 @@",
      "+      hostNetwork: true",
      "+      dnsPolicy: ClusterFirstWithHostNet",
    ].join("\n"),
  );
  assert.deepEqual(k8s, [
    { file: "deploy/k8s/app.yaml", line: 10, kind: "open-ingress" },
  ]);

  const compose = scanPatchForIacMisconfig(
    "docker-compose.yml",
    ["@@ -1,0 +5,1 @@", "+    network_mode: host"].join("\n"),
  );
  assert.deepEqual(compose, [
    { file: "docker-compose.yml", line: 5, kind: "open-ingress" },
  ]);
});

test("scanPatchForIacMisconfig flags K8s and Helm TLS skip settings", () => {
  const k8s = scanPatchForIacMisconfig(
    "values.yaml",
    ["@@ -20,0 +20,1 @@", "+  insecureSkipTLSVerify: true"].join("\n"),
  );
  assert.deepEqual(k8s, [
    { file: "values.yaml", line: 20, kind: "tls-verification-disabled" },
  ]);

  const helm = scanPatchForIacMisconfig(
    "charts/app/values.yaml",
    ["@@ -3,0 +3,1 @@", '+  skipTLSVerify: "true"'].join("\n"),
  );
  assert.deepEqual(helm, [
    {
      file: "charts/app/values.yaml",
      line: 3,
      kind: "tls-verification-disabled",
    },
  ]);
});

test("scanPatchForIacMisconfig flags NODE_TLS_REJECT_UNAUTHORIZED=0 as TLS verification disabled", () => {
  // Canonical Node env var that disables ALL TLS certificate verification process-wide — the env-var equivalent
  // of the already-detected `rejectUnauthorized: false`. Covers .env, Dockerfile ENV, and quoted YAML/JSON forms.
  const dotenv = scanPatchForIacMisconfig(
    ".env.production",
    ["@@ -1,0 +7,1 @@", "+NODE_TLS_REJECT_UNAUTHORIZED=0"].join("\n"),
  );
  assert.deepEqual(dotenv, [
    { file: ".env.production", line: 7, kind: "tls-verification-disabled" },
  ]);

  const dockerfile = scanPatchForIacMisconfig(
    "Dockerfile",
    ["@@ -1,0 +3,1 @@", "+ENV NODE_TLS_REJECT_UNAUTHORIZED 0"].join("\n"),
  );
  assert.deepEqual(dockerfile, [
    { file: "Dockerfile", line: 3, kind: "tls-verification-disabled" },
  ]);

  const quoted = scanPatchForIacMisconfig(
    "compose.yaml",
    ["@@ -1,0 +9,1 @@", '+      NODE_TLS_REJECT_UNAUTHORIZED: "0"'].join("\n"),
  );
  assert.deepEqual(quoted, [
    { file: "compose.yaml", line: 9, kind: "tls-verification-disabled" },
  ]);
});

test("scanPatchForIacMisconfig does not flag NODE_TLS_REJECT_UNAUTHORIZED when TLS stays enabled", () => {
  // Only the value `0` disables verification; `1` (verification on) must not be flagged.
  assert.deepEqual(
    scanPatchForIacMisconfig(
      ".env",
      "@@ -1,0 +1,1 @@\n+NODE_TLS_REJECT_UNAUTHORIZED=1",
    ),
    [],
  );
});

test("scanPatchForIacMisconfig flags PYTHONHTTPSVERIFY=0 and GIT_SSL_NO_VERIFY truthy as disabled TLS", () => {
  // Canonical per-runtime env vars that globally disable TLS certificate verification.
  const python = scanPatchForIacMisconfig(
    ".env",
    ["@@ -1,0 +2,1 @@", "+PYTHONHTTPSVERIFY=0"].join("\n"),
  );
  assert.deepEqual(python, [
    { file: ".env", line: 2, kind: "tls-verification-disabled" },
  ]);

  const git = scanPatchForIacMisconfig(
    "Dockerfile",
    ["@@ -1,0 +4,1 @@", "+ENV GIT_SSL_NO_VERIFY true"].join("\n"),
  );
  assert.deepEqual(git, [
    { file: "Dockerfile", line: 4, kind: "tls-verification-disabled" },
  ]);

  const gitNumeric = scanPatchForIacMisconfig(
    "ci.yaml",
    ["@@ -1,0 +6,1 @@", '+  GIT_SSL_NO_VERIFY: "1"'].join("\n"),
  );
  assert.deepEqual(gitNumeric, [
    { file: "ci.yaml", line: 6, kind: "tls-verification-disabled" },
  ]);
});

test("scanPatchForIacMisconfig does not flag Python/Git TLS env vars when verification stays on", () => {
  // Opposite polarities: PYTHONHTTPSVERIFY=1 keeps verification on; GIT_SSL_NO_VERIFY=false/0 means "verify".
  assert.deepEqual(
    scanPatchForIacMisconfig(".env", "@@ -1,0 +1,1 @@\n+PYTHONHTTPSVERIFY=1"),
    [],
  );
  assert.deepEqual(
    scanPatchForIacMisconfig(
      ".env",
      "@@ -1,0 +1,1 @@\n+GIT_SSL_NO_VERIFY=false",
    ),
    [],
  );
  assert.deepEqual(
    scanPatchForIacMisconfig(".env", "@@ -1,0 +1,1 @@\n+GIT_SSL_NO_VERIFY=0"),
    [],
  );
});

test("scanPatchForIacMisconfig ignores unchanged lines and honors maxFindings", () => {
  assert.deepEqual(
    scanPatchForIacMisconfig(
      "docker-compose.yml",
      "@@ -1,1 +1,1 @@\n     network_mode: host",
    ),
    [],
  );
  assert.deepEqual(
    scanPatchForIacMisconfig(
      "docker-compose.yml",
      "@@ -1,0 +1,1 @@\n+    network_mode: host",
      {
        maxFindings: 0,
      },
    ),
    [],
  );
});

test("scanPatchForIacMisconfig aborts when the signal is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      scanPatchForIacMisconfig(
        "docker-compose.yml",
        "@@ -1,0 +1,1 @@\n+    network_mode: host",
        {
          signal: controller.signal,
        },
      ),
    /analyzer_aborted/,
  );
});
