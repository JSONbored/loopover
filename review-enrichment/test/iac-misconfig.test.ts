import { test } from "node:test";
import assert from "node:assert/strict";

import { isRelevantConfigPath, scanPatchForIacMisconfig } from "../dist/analyzers/iac-misconfig.js";

test("isRelevantConfigPath recognizes Terraform .tfvars and HCL files (siblings of .tf)", () => {
  // `.tf` was already scanned; `.tfvars` and `.hcl` end after `tf`, so the extension
  // group missed them and scanIacMisconfig skipped these canonical IaC files entirely.
  assert.ok(isRelevantConfigPath("infra/terraform.tfvars"));
  assert.ok(isRelevantConfigPath("env/prod.auto.tfvars"));
  assert.ok(isRelevantConfigPath("packer/build.pkr.hcl"));
  assert.ok(isRelevantConfigPath("infra/main.tf")); // the pre-existing sibling still matches
  assert.equal(isRelevantConfigPath("src/app.ts"), false); // a non-config source file does not
});

test("scanPatchForIacMisconfig flags hostNetwork and compose host network mode", () => {
  const k8s = scanPatchForIacMisconfig(
    "deploy/k8s/app.yaml",
    ["@@ -10,0 +10,2 @@", "+      hostNetwork: true", "+      dnsPolicy: ClusterFirstWithHostNet"].join("\n"),
  );
  assert.deepEqual(k8s, [{ file: "deploy/k8s/app.yaml", line: 10, kind: "open-ingress" }]);

  const compose = scanPatchForIacMisconfig(
    "docker-compose.yml",
    ["@@ -1,0 +5,1 @@", "+    network_mode: host"].join("\n"),
  );
  assert.deepEqual(compose, [{ file: "docker-compose.yml", line: 5, kind: "open-ingress" }]);
});

test("scanPatchForIacMisconfig flags K8s and Helm TLS skip settings", () => {
  const k8s = scanPatchForIacMisconfig(
    "values.yaml",
    ["@@ -20,0 +20,1 @@", "+  insecureSkipTLSVerify: true"].join("\n"),
  );
  assert.deepEqual(k8s, [{ file: "values.yaml", line: 20, kind: "tls-verification-disabled" }]);

  const helm = scanPatchForIacMisconfig(
    "charts/app/values.yaml",
    ["@@ -3,0 +3,1 @@", '+  skipTLSVerify: "true"'].join("\n"),
  );
  assert.deepEqual(helm, [{ file: "charts/app/values.yaml", line: 3, kind: "tls-verification-disabled" }]);
});

test("scanPatchForIacMisconfig ignores unchanged lines and honors maxFindings", () => {
  assert.deepEqual(
    scanPatchForIacMisconfig("docker-compose.yml", "@@ -1,1 +1,1 @@\n     network_mode: host"),
    [],
  );
  assert.deepEqual(
    scanPatchForIacMisconfig("docker-compose.yml", "@@ -1,0 +1,1 @@\n+    network_mode: host", {
      maxFindings: 0,
    }),
    [],
  );
});

test("scanPatchForIacMisconfig aborts when the signal is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      scanPatchForIacMisconfig("docker-compose.yml", "@@ -1,0 +1,1 @@\n+    network_mode: host", {
        signal: controller.signal,
      }),
    /analyzer_aborted/,
  );
});
