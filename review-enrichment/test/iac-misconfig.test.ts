import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isRelevantConfigPath,
  scanIacMisconfig,
  scanPatchForIacMisconfig,
} from "../dist/analyzers/iac-misconfig.js";

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

test("scanPatchForIacMisconfig flags PYTHONHTTPSVERIFY=0 as TLS verification disabled", () => {
  // Python's stdlib `urllib`/`requests` honor this env var; `0` disables certificate verification
  // process-wide — the Python equivalent of `NODE_TLS_REJECT_UNAUTHORIZED=0`.
  const dotenv = scanPatchForIacMisconfig(
    ".env.production",
    ["@@ -1,0 +7,1 @@", "+PYTHONHTTPSVERIFY=0"].join("\n"),
  );
  assert.deepEqual(dotenv, [
    { file: ".env.production", line: 7, kind: "tls-verification-disabled" },
  ]);

  const dockerfile = scanPatchForIacMisconfig(
    "Dockerfile",
    ["@@ -1,0 +3,1 @@", "+ENV PYTHONHTTPSVERIFY 0"].join("\n"),
  );
  assert.deepEqual(dockerfile, [
    { file: "Dockerfile", line: 3, kind: "tls-verification-disabled" },
  ]);

  const quoted = scanPatchForIacMisconfig(
    "compose.yaml",
    ["@@ -1,0 +9,1 @@", '+      PYTHONHTTPSVERIFY: "0"'].join("\n"),
  );
  assert.deepEqual(quoted, [
    { file: "compose.yaml", line: 9, kind: "tls-verification-disabled" },
  ]);
});

test("scanPatchForIacMisconfig does not flag PYTHONHTTPSVERIFY when verification stays on", () => {
  // Only the value `0` disables verification; `1` (verification on) must not be flagged.
  assert.deepEqual(
    scanPatchForIacMisconfig(
      ".env",
      "@@ -1,0 +1,1 @@\n+PYTHONHTTPSVERIFY=1",
    ),
    [],
  );
});

test("isRelevantConfigPath recognizes environment-specific dotenv files", async () => {
  // The path gate must admit mode-suffixed dotenv files (`.env.production`, `.env.local`,
  // `apps/api/.env.staging`) — the canonical home of `NODE_TLS_REJECT_UNAUTHORIZED=0` — not only a bare `.env`.
  // Otherwise the analyzer entrypoint skips them and the TLS/CORS/secret findings never fire in real use.
  assert.equal(isRelevantConfigPath(".env"), true);
  assert.equal(isRelevantConfigPath(".env.production"), true);
  assert.equal(isRelevantConfigPath(".env.local"), true);
  assert.equal(isRelevantConfigPath("apps/api/.env.staging"), true);
  // Must not over-match a non-dotenv name that merely contains "env".
  assert.equal(isRelevantConfigPath(".environment"), false);
  assert.equal(isRelevantConfigPath("src/index.ts"), false);

  // End-to-end through the gated entrypoint: a mode-suffixed dotenv file must actually be scanned.
  const findings = await scanIacMisconfig({
    files: [
      {
        path: ".env.production",
        patch: "@@ -1,0 +7,1 @@\n+NODE_TLS_REJECT_UNAUTHORIZED=0",
      },
    ],
  });
  assert.deepEqual(findings, [
    { file: ".env.production", line: 7, kind: "tls-verification-disabled" },
  ]);
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

test("scanPatchForIacMisconfig keeps line numbers correct across a no-newline marker", () => {
  // A dotenv file with no trailing newline (very common) gets a `\ No newline at end of file` marker
  // mid-hunk. The marker must not shift the new-file line counter, so NODE_TLS_REJECT_UNAUTHORIZED=0 is
  // reported at line 2, not line 3.
  const findings = scanPatchForIacMisconfig(
    ".env.production",
    [
      "@@ -1,1 +1,2 @@",
      "-FOO=bar",
      "\\ No newline at end of file",
      "+FOO=bar",
      "+NODE_TLS_REJECT_UNAUTHORIZED=0",
      "\\ No newline at end of file",
    ].join("\n"),
  );
  assert.deepEqual(findings, [
    { file: ".env.production", line: 2, kind: "tls-verification-disabled" },
  ]);
});

test("scanPatchForIacMisconfig flags container securityContext and cloud hardening misconfigurations", () => {
  // Each added line is the insecure form of a recognized check (Kubernetes Pod Security Standards
  // restricted profile + tfsec/checkov cloud rules) and must produce exactly one finding of its own kind.
  const cases = [
    ["+      privileged: true", "privileged-container"],
    ["+      allowPrivilegeEscalation: true", "privilege-escalation"],
    ["+      hostPID: true", "host-pid-namespace"],
    ["+      hostIPC: true", "host-ipc-namespace"],
    ["+      runAsNonRoot: false", "run-as-root"],
    ["+      runAsUser: 0", "run-as-root-uid"],
    ["+      readOnlyRootFilesystem: false", "writable-root-filesystem"],
    ["+      procMount: Unmasked", "unmasked-proc-mount"],
    ["+  storage_encrypted = false", "unencrypted-storage"],
    ["+  publicly_accessible = true", "publicly-accessible-database"],
    ['+    http_tokens = "optional"', "imdsv1-allowed"],
    ["+RUN chmod 777 /app/entrypoint.sh", "world-writable-permissions"],
  ];
  for (const [added, kind] of cases) {
    const findings = scanPatchForIacMisconfig(
      "deploy/app.yaml",
      ["@@ -1,0 +1,1 @@", added].join("\n"),
    );
    assert.deepEqual(
      findings,
      [{ file: "deploy/app.yaml", line: 1, kind }],
      `${kind}: expected exactly one finding of that kind, got ${JSON.stringify(findings)}`,
    );
  }
});

test("scanPatchForIacMisconfig does not flag the secure counterpart of each container/cloud setting", () => {
  // The safe value of every new rule, plus three deliberate near-misses: `unprivileged: true` (word boundary
  // must not fire the `privileged` rule), `runAsUser: 1000` (a non-root uid must not match the `runAsUser: 0`
  // rule), and `chmod 1777` (a sticky-bit dir must not match the world-writable `0777` rule).
  const safe = [
    "+      privileged: false",
    "+      unprivileged: true",
    "+      allowPrivilegeEscalation: false",
    "+      hostPID: false",
    "+      hostIPC: false",
    "+      runAsNonRoot: true",
    "+      runAsUser: 1000",
    "+      readOnlyRootFilesystem: true",
    "+      procMount: Default",
    "+  storage_encrypted = true",
    "+  publicly_accessible = false",
    '+    http_tokens = "required"',
    "+RUN chmod 750 /app/entrypoint.sh",
    "+RUN chmod 1777 /tmp/scratch",
  ];
  for (const added of safe) {
    assert.deepEqual(
      scanPatchForIacMisconfig(
        "deploy/app.yaml",
        ["@@ -1,0 +1,1 @@", added].join("\n"),
      ),
      [],
      `should not flag: ${added.trim()}`,
    );
  }
});

test("scanPatchForIacMisconfig flags insecure Dockerfile build instructions", () => {
  // Each added line is a recognized hadolint/checkov Dockerfile-hardening violation and must produce
  // exactly one finding of its own kind.
  const cases = [
    ["+ADD https://example.com/app.tar.gz /app/", "docker-add-remote-url"],
    ["+FROM node:latest", "docker-image-latest-tag"],
    ["+USER root", "docker-root-user"],
    ["+RUN curl -fsSL https://get.example.com | sh", "remote-shell-pipe"],
    ["+RUN wget --no-check-certificate https://example.com/x -O /x", "insecure-download-flag"],
    ["+EXPOSE 22", "ssh-port-exposed"],
    ["+RUN npm install --unsafe-perm", "npm-unsafe-perm"],
    ["+RUN sudo apt-get update", "sudo-in-build"],
    ["+ENV DB_PASSWORD=hunter2", "hardcoded-build-secret"],
    ["+RUN pip install --index-url http://pypi.internal/simple foo", "insecure-pip-index"],
  ];
  for (const [added, kind] of cases) {
    const findings = scanPatchForIacMisconfig(
      "Dockerfile",
      ["@@ -1,0 +1,1 @@", added].join("\n"),
    );
    assert.deepEqual(
      findings,
      [{ file: "Dockerfile", line: 1, kind }],
      `${kind}: expected exactly one finding of that kind, got ${JSON.stringify(findings)}`,
    );
  }
});

test("scanPatchForIacMisconfig treats Dockerfile instruction keywords case-insensitively", () => {
  // Dockerfile instructions are case-insensitive, so lowercase instructions must not bypass
  // the build-hardening findings that the uppercase forms already produce.
  const cases = [
    ["+add https://example.com/app.tar.gz /app/", "docker-add-remote-url"],
    ["+from node:latest", "docker-image-latest-tag"],
    ["+user root", "docker-root-user"],
    ["+expose 22", "ssh-port-exposed"],
    ["+run sudo apt-get update", "sudo-in-build"],
  ];

  for (const [added, kind] of cases) {
    const findings = scanPatchForIacMisconfig(
      "Dockerfile",
      ["@@ -1,0 +1,1 @@", added].join("\n"),
    );
    assert.deepEqual(
      findings,
      [{ file: "Dockerfile", line: 1, kind }],
      `${kind}: expected lowercase Dockerfile instruction to be detected, got ${JSON.stringify(findings)}`,
    );
  }
});

test("scanPatchForIacMisconfig does not flag the safe counterpart of each Dockerfile instruction", () => {
  // Safe/near-miss forms: a local ADD source, a pinned image tag, a non-root user (incl. a non-zero uid), a
  // curl without a shell pipe, a wget without the insecure flag, a non-SSH port (incl. 2222), npm without
  // --unsafe-perm, `apt-get install sudo` (installing, not invoking), a bare ARG declaration, and an HTTPS index.
  const safe = [
    "+ADD ./local.tar.gz /app/",
    "+FROM node:20.11.0",
    "+USER appuser",
    "+USER 1000",
    "+RUN curl -fsSL https://example.com/x -o /tmp/x",
    "+RUN wget https://example.com/x",
    "+EXPOSE 8080",
    "+EXPOSE 2222",
    "+RUN npm install",
    "+RUN apt-get install -y sudo",
    "+ARG DB_PASSWORD",
    "+ENV APP_NAME=myapp",
    "+RUN pip install --index-url https://pypi.internal/simple foo",
  ];
  for (const added of safe) {
    assert.deepEqual(
      scanPatchForIacMisconfig("Dockerfile", ["@@ -1,0 +1,1 @@", added].join("\n")),
      [],
      `should not flag: ${added.trim()}`,
    );
  }
});

test("scanPatchForIacMisconfig flags TLS/certificate-verification bypass across ecosystems", () => {
  // In each case the matched VALUE is the bypass action itself, so there is no safe-value form of the line.
  const cases = [
    ["+DATABASE_URL=postgres://u:p@h/db?sslmode=disable", "db-ssl-disabled"],
    ["+  GIT_SSL_NO_VERIFY: true", "git-ssl-no-verify"],
    ["+  StrictHostKeyChecking no", "ssh-host-key-check-off"],
    ["+  verify_ssl: false", "verify-ssl-off"],
    ["+  validate_certs: no", "validate-certs-off"],
    ["+  insecure_skip_verify = true", "tls-skip-verify"],
    ["+  ConnectionString: Server=db;TrustServerCertificate=true", "trust-all-server-certs"],
  ];
  for (const [added, kind] of cases) {
    const findings = scanPatchForIacMisconfig(
      "config.yaml",
      ["@@ -1,0 +1,1 @@", added].join("\n"),
    );
    assert.deepEqual(
      findings,
      [{ file: "config.yaml", line: 1, kind }],
      `${kind}: expected exactly one finding of that kind, got ${JSON.stringify(findings)}`,
    );
  }
});

test("scanPatchForIacMisconfig does not flag the secure counterpart of each TLS-bypass setting", () => {
  // The secure value uses a different token the regex never matches (verification stays ON).
  const safe = [
    "+DATABASE_URL=postgres://u:p@h/db?sslmode=require",
    "+  GIT_SSL_NO_VERIFY: false",
    "+  StrictHostKeyChecking yes",
    "+  verify_ssl: true",
    "+  validate_certs: yes",
    "+  insecure_skip_verify = false",
    "+  ConnectionString: Server=db;TrustServerCertificate=false",
  ];
  for (const added of safe) {
    assert.deepEqual(
      scanPatchForIacMisconfig("config.yaml", ["@@ -1,0 +1,1 @@", added].join("\n")),
      [],
      `should not flag: ${added.trim()}`,
    );
  }
});

test("scanPatchForIacMisconfig flags insecure Docker Compose / container-runtime settings", () => {
  // In each case the matched VALUE is the insecure action itself, so there is no safe-value form of the line.
  const cases = [
    ["+    security_opt: [seccomp:unconfined]", "seccomp-unconfined-runtime"],
    ["+      - apparmor:unconfined", "apparmor-unconfined"],
    ["+    userns_mode: host", "userns-host"],
    ["+    ipc: host", "ipc-host"],
    ["+    cap_add: [ALL]", "cap-add-all"],
    ["+      - no-new-privileges:false", "no-new-privileges-off"],
    ["+      - /var/run/docker.sock:/var/run/docker.sock", "docker-socket-mount"], // short syntax
    ["+        source: /var/run/docker.sock", "docker-socket-mount"], // long syntax (bind mount source)
  ];
  for (const [added, kind] of cases) {
    const findings = scanPatchForIacMisconfig(
      "docker-compose.yml",
      ["@@ -1,0 +1,1 @@", added].join("\n"),
    );
    assert.deepEqual(
      findings,
      [{ file: "docker-compose.yml", line: 1, kind }],
      `${kind}: expected exactly one finding of that kind, got ${JSON.stringify(findings)}`,
    );
  }
});

test("scanPatchForIacMisconfig does not flag the secure counterpart of each container-runtime setting", () => {
  // The secure value uses a different token the regex never matches. `cap_drop: [ALL]` is the SAFE hardening
  // (drop all caps) and must not fire the `cap_add: [ALL]` rule.
  const safe = [
    "+    security_opt: [seccomp:runtime-default]",
    "+      - apparmor:docker-default",
    "+    userns_mode: private",
    "+    ipc: private",
    "+    cap_drop: [ALL]",
    "+      - no-new-privileges:true",
    "+      - ./data:/app/data",
    // Referencing the socket path (how the CLI addresses the daemon) is NOT a mount — must not be flagged.
    "+    DOCKER_HOST: unix:///var/run/docker.sock",
  ];
  for (const added of safe) {
    assert.deepEqual(
      scanPatchForIacMisconfig("docker-compose.yml", ["@@ -1,0 +1,1 @@", added].join("\n")),
      [],
      `should not flag: ${added.trim()}`,
    );
  }
});

test("scanPatchForIacMisconfig flags insecure HTTP security-header settings", () => {
  // Each matched value is the weakening itself, so there is no safe-value form of the same line.
  const cases = [
    ["+    add_header Strict-Transport-Security \"max-age=0\";", "hsts-disabled"],
    ["+    add_header Referrer-Policy \"unsafe-url\";", "referrer-policy-leak"],
    ["+    httpOnly: false", "cookie-not-httponly"],
    ["+    add_header Cross-Origin-Opener-Policy \"unsafe-none\";", "coop-unsafe-none"],
    ["+    add_header X-XSS-Protection \"0\";", "x-xss-protection-off"],
    ["+    add_header X-Frame-Options \"ALLOWALL\";", "frame-options-allowall"],
  ];
  for (const [added, kind] of cases) {
    const findings = scanPatchForIacMisconfig(
      "nginx.conf",
      ["@@ -1,0 +1,1 @@", added].join("\n"),
    );
    assert.deepEqual(
      findings,
      [{ file: "nginx.conf", line: 1, kind }],
      `${kind}: expected exactly one finding of that kind, got ${JSON.stringify(findings)}`,
    );
  }
});

test("scanPatchForIacMisconfig does not flag secure HTTP header values (incl. Cache-Control max-age=0)", () => {
  const safe = [
    "+    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\";",
    // Cache-Control max-age=0 is a NORMAL caching directive and must NOT fire the HSTS rule.
    "+    add_header Cache-Control \"max-age=0\";",
    "+    add_header Referrer-Policy \"strict-origin-when-cross-origin\";",
    "+    httpOnly: true",
    "+    add_header Cross-Origin-Opener-Policy \"same-origin\";",
    "+    add_header X-XSS-Protection \"1; mode=block\";",
    "+    add_header X-Frame-Options \"SAMEORIGIN\";",
    // A bare `unsafe-none` config key without the COOP header token must NOT fire the COOP rule.
    "+    unsafe-none = false",
  ];
  for (const added of safe) {
    assert.deepEqual(
      scanPatchForIacMisconfig("nginx.conf", ["@@ -1,0 +1,1 @@", added].join("\n")),
      [],
      `should not flag: ${added.trim()}`,
    );
  }
});
