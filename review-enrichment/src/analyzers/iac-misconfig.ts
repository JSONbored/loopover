import type { EnrichRequest, IacMisconfigFinding } from "../types.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const CONFIG_PATH_RE =
  /(?:^|\/)(?:docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|values(?:\.[^/]+)?\.ya?ml|\.env(?:\.[^/]+)?|.*\.(?:tf|tfvars|hcl|ya?ml|json|toml|ini|conf|env)|Dockerfile(?:\.[^/]+)?|nginx[^/]*\.conf)$/i;

const CORS_ORIGIN_RE =
  /\b(?:access-control-allow-origin|allow_origin|cors_origin|origin)\b[\s"'=:,\[\]-]*\*/i;
const CORS_CREDENTIALS_RE =
  /\b(?:access-control-allow-credentials|allow_credentials|credentials)\b[\s"'=:,-]*(?:true|yes|on)\b/i;
const OPEN_INGRESS_RE =
  /\b(?:cidr_blocks|source_ranges|ipv4_cidr_blocks|cidr|ip_range|value)\b[^\n#]*0\.0\.0\.0\/0\b|\b0\.0\.0\.0\/0\b/i;
const HOST_NETWORK_RE =
  /\bhostNetwork\b[\s"'=:,-]*true\b|\bnetwork_mode\b[\s"'=:,-]*host\b/i;
const PUBLIC_BUCKET_RE =
  /(?:(?:["'])?(?:bucket_)?acl(?:["'])?\s*[=:]\s*["']public-(?:read|read-write)["']|(?:["'])?public_access(?:["'])?\s*[=:]\s*true\b|(?:["'])?public(?:["'])?\s*[=:]\s*true\b|(?:["'])?block_public_(?:acls|policy)(?:["'])?\s*[=:]\s*false\b)/i;
const SAME_SITE_NONE_RE = /\bsameSite\b[\s"'=:,-]*["']?none["']?\b/i;
const SECURE_FALSE_RE = /\bsecure\b[\s"'=:,-]*false\b/i;
const TLS_DISABLED_RE =
  /\brejectUnauthorized\b[\s"'=:,-]*false\b|\bverify\s*=\s*False\b|\bssl_verify\b[\s"'=:,-]*false\b|\binsecureSkipTLSVerify\b[\s"'=:,-]*true\b|\bskipTLSVerify\b[\s"'=:,-]*true\b|\bNODE_TLS_REJECT_UNAUTHORIZED\b[\s"'=:,-]*["']?0\b|\bPYTHONHTTPSVERIFY\b[\s"'=:,-]*["']?0\b/i;
const PROD_RE =
  /\b(?:NODE_ENV|ENVIRONMENT|APP_ENV)\b[\s"'=:,-]*production\b|\bproduction\s*:/i;
const DEBUG_TRUE_RE = /\bdebug\b[\s"'=:,-]*true\b|\bDEBUG\b[\s"'=:,-]*true\b/i;
const HARDCODED_URL_RE =
  /\b(?:[A-Z][A-Z0-9_]*(?:URL|URI|ENDPOINT)|(?:api|base|service|backend|frontend|server|webhook)[_-]?(?:url|uri|endpoint)|baseUrl)\b[\s"'=:,-]*https?:\/\/[^\s"',#}]+/i;

// Container securityContext / Kubernetes Pod Security Standards (restricted profile). Each matches a single
// `key: <insecure-value>` line; the secure value (e.g. `privileged: false`) never matches. `\bprivileged\b`
// deliberately does NOT fire on the safe `unprivileged: true` (word boundary fails after the `un` prefix).
const PRIVILEGED_RE = /\bprivileged\b[\s"'=:,-]*true\b/i;
const PRIVILEGE_ESCALATION_RE = /\ballowPrivilegeEscalation\b[\s"'=:,-]*true\b/i;
const HOST_PID_RE = /\bhostPID\b[\s"'=:,-]*true\b/i;
const HOST_IPC_RE = /\bhostIPC\b[\s"'=:,-]*true\b/i;
const RUN_AS_ROOT_RE = /\brunAsNonRoot\b[\s"'=:,-]*false\b/i;
// `runAsUser: 0` is root. The separators are zero-width-optional, so a non-zero uid like `runAsUser: 1000`
// cannot match (the value must begin with a `0` immediately after the separators).
const RUN_AS_UID_ZERO_RE = /\brunAsUser\b[\s"'=:,-]*0\b/i;
const WRITABLE_ROOTFS_RE = /\breadOnlyRootFilesystem\b[\s"'=:,-]*false\b/i;
const UNMASKED_PROC_RE = /\bprocMount\b[\s"'=:,-]*["']?Unmasked\b/i;

// Cloud / Terraform resource hardening. `\b(?:storage_encrypted|encrypted)\b` matches the standalone
// `encrypted` key and the `storage_encrypted` key, but never the `_encrypted` tail of an unrelated identifier.
const UNENCRYPTED_STORAGE_RE = /\b(?:storage_encrypted|encrypted)\b[\s"'=:,-]*false\b/i;
const PUBLIC_DB_RE = /\bpublicly_accessible\b[\s"'=:,-]*true\b/i;
const IMDS_V1_RE = /\bhttp_tokens\b[\s"'=:,-]*["']?optional\b/i;
// World-writable `0777`/`777` via `chmod`, a `mode:`/`file_mode` assignment. A leading sticky/setuid digit
// (`chmod 1777`) does not match because the value must begin at the optional `0` then `777`.
const WORLD_WRITABLE_RE = /\b(?:chmod\s+|(?:file_)?mode[\s"'=:,-]*["']?)0?777\b/i;

// Dockerfile build-security hardening (hadolint / checkov CKV_DOCKER_*). Dockerfile instruction
// keywords are case-insensitive, so match ADD/FROM/USER/EXPOSE/RUN without relying on casing.
// The flag/shell shapes are risky in any build/config file the path gate already admits.
const DOCKER_ADD_REMOTE_RE = /\bADD\s+(?:--\S+\s+)*https?:\/\/\S/i;
const DOCKER_LATEST_TAG_RE = /\bFROM\s+(?:--\S+\s+)*\S+:latest\b/i;
const DOCKER_ROOT_USER_RE = /\bUSER\s+(?:root|0)\b/i;
// A remote download piped straight into a shell — the classic `curl … | sh` run-remote-code-at-build shape.
const REMOTE_SHELL_PIPE_RE =
  /\b(?:curl|wget)\b[^\n]*?\|\s*(?:sudo\s+)?(?:bash|zsh|ksh|dash|ash|sh)\b/;
// Build flags that disable download / TLS certificate verification (wget/apt/curl/pip).
const INSECURE_DOWNLOAD_FLAG_RE =
  /--(?:no-check-certificate|allow-unauthenticated|force-yes|trusted-host)\b/;
const SSH_PORT_EXPOSED_RE = /\bEXPOSE\s+(?:\d+(?:\/\w+)?\s+)*22(?:\/tcp)?\b/i;
const NPM_UNSAFE_PERM_RE = /--unsafe-perm\b/;
// `sudo` invoked inside a RUN layer (privilege elevation during build). `RUN apt-get install sudo` does NOT
// match because sudo does not immediately follow `RUN`/`&&`.
const SUDO_IN_BUILD_RE = /\bRUN\s+sudo\s|&&\s*sudo\s/i;
// A credential-shaped value hardcoded into an image layer via ENV/ARG WITH a value (build secrets persist in
// the image history). A bare `ARG DB_PASSWORD` (no `=value`) is a legitimate build-arg declaration and is skipped.
const HARDCODED_BUILD_SECRET_RE =
  /\b(?:ENV|ARG)\s+\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)\w*\s*=\s*\S/i;
// A package installer pointed at a plaintext-HTTP index (dependency-download MITM).
const INSECURE_PIP_INDEX_RE = /--(?:extra-)?index-url[=\s]+http:\/\//i;

// TLS / certificate-verification bypass across ecosystems. In every case the MATCHED VALUE is the bypass
// action itself (disabling verification / trusting any certificate), so there is no "safe value" form of the
// same line — the secure setting uses a different value the regex never matches. Complements the existing
// `tls-verification-disabled` rule with database-, Go-, Git-, SSH-, PHP-, .NET-, and Kubernetes-specific forms.
const DB_SSL_DISABLED_RE = /\bssl[_-]?mode\s*[=:]\s*["']?(?:disable|disabled|none)\b/i;
const GIT_SSL_NO_VERIFY_RE = /\bGIT_SSL_NO_VERIFY\b[\s"'=:,-]*["']?(?:1|true|yes)\b/i;
const SSH_HOST_KEY_OFF_RE = /\bStrictHostKeyChecking\b[\s"'=:,-]*["']?(?:no|false)\b/i;
const VERIFY_SSL_OFF_RE = /\bverify[_-]?(?:ssl|certs?|certificate)\b[\s"'=:,-]*["']?(?:false|no|0)\b/i;
const VALIDATE_CERTS_OFF_RE = /\bvalidate_certs\b[\s"'=:,-]*["']?(?:no|false)\b/i;
const TLS_SKIP_VERIFY_RE = /\b(?:tls_skip_verify|insecure_skip_verify)\b[\s"'=:,-]*true\b/i;
const TRUST_ALL_CERTS_RE = /\bTrustServerCertificate\s*=\s*["']?true\b/i;

// Docker Compose / container-runtime hardening. In each case the MATCHED VALUE is the insecure action itself
// (dropping a confinement, sharing a host namespace, granting all capabilities, or mounting the host Docker
// socket), so there is no "safe value" form of the same line — the secure setting uses a different value the
// regex never matches. `cap_add` is the ADD list specifically, so `cap_drop: [ALL]` (the safe hardening) is
// never matched.
const SECCOMP_UNCONFINED_RE = /\bseccomp[=:]\s*["']?unconfined\b/i;
const APPARMOR_UNCONFINED_RE = /\bapparmor[=:]\s*["']?unconfined\b/i;
const USERNS_HOST_RE = /\buserns_mode\s*:\s*["']?host\b/i;
const IPC_HOST_RE = /\bipc\s*:\s*["']?host\b/i;
const CAP_ADD_ALL_RE = /\bcap_add\b[^\n]*\bALL\b/;
const NO_NEW_PRIVILEGES_OFF_RE = /\bno-new-privileges[=:]\s*["']?false\b/i;
// A bind mount of the host Docker socket into a container, in either Compose syntax: the short form
// `- /var/run/docker.sock:<target>` (trailing `:` = the source→target separator) OR the long form's
// `source: /var/run/docker.sock` line. Both name the socket as a mount source; matching either line alone is
// sufficient (a mount of the host socket is the risk regardless of target). A plain reference such as
// `DOCKER_HOST=unix:///var/run/docker.sock` — the normal way the CLI addresses the daemon, not a mount — has
// neither shape, so it is NOT flagged.
const DOCKER_SOCKET_MOUNT_RE =
  /\/var\/run\/docker\.sock:|\bsource\s*:\s*["']?\/var\/run\/docker\.sock\b/;

// HTTP security-header misconfigurations (nginx/Apache/Caddy conf, Helm ingress annotations, netlify.toml
// headers, …). Each rule requires ITS OWN header token to be present on the same line as the weakening value,
// so an unrelated line that merely contains the value (a `Cache-Control: max-age=0` caching directive) is NOT
// flagged — only a line that is actually setting that header.
const HSTS_DISABLED_RE = /\bStrict-Transport-Security\b[^\n]*\bmax-age\s*=\s*0\b/i;
const REFERRER_UNSAFE_URL_RE = /\bReferrer-Policy\b[^\n]*\bunsafe-url\b/i;
const COOKIE_NOT_HTTPONLY_RE = /\bhttp[_-]?only\b[\s"'=:,-]*false\b/i;
const COOP_UNSAFE_NONE_RE =
  /\bCross-Origin-Opener-Policy\b[^\n]*\bunsafe-none\b/i;
// The value must be exactly `0` (filter off), not `10`/`01` — `(?![0-9])` rejects a digit continuation.
// Accepts both `X-XSS-Protection: 0` and nginx `add_header X-XSS-Protection "0"`.
const XSS_PROTECTION_OFF_RE =
  /\bX-XSS-Protection\b(?:\s*:\s*|\s+)["']?0(?![0-9])/i;
const FRAME_OPTIONS_ALLOWALL_RE = /\bX-Frame-Options\b[^\n]*\bALLOWALL\b/i;

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

export function isRelevantConfigPath(path: string): boolean {
  return CONFIG_PATH_RE.test(path);
}

function pushFinding(
  findings: IacMisconfigFinding[],
  seen: Set<string>,
  file: string,
  line: number,
  kind: IacMisconfigFinding["kind"],
  maxFindings: number,
): boolean {
  const key = `${kind}:${line}`;
  if (seen.has(key)) return false;
  seen.add(key);
  findings.push({ file, line, kind });
  return findings.length >= maxFindings;
}

export function scanPatchForIacMisconfig(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): IacMisconfigFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];

  const findings: IacMisconfigFinding[] = [];
  const seen = new Set<string>();
  let newLine = 0;
  let corsOriginLine = 0;
  let corsCredentialsLine = 0;
  let sameSiteLine = 0;
  let secureFalseLine = 0;
  let prodLine = 0;
  let debugLine = 0;
  let inHunk = false;

  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      corsOriginLine = 0;
      corsCredentialsLine = 0;
      sameSiteLine = 0;
      secureFalseLine = 0;
      prodLine = 0;
      debugLine = 0;
      inHunk = true;
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (!line.startsWith("+")) {
      // A `\ No newline at end of file` marker is not a content line, so it must not advance the
      // new-file line counter — otherwise every finding after it is reported one line too high. Mirrors
      // the sibling analyzers (e.g. undocumented-export.ts) that already skip `\`-prefixed markers.
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine++;
      continue;
    }

    const body = line.slice(1);
    if (body.length > MAX_LINE_CHARS) {
      newLine++;
      continue;
    }

    if (CORS_ORIGIN_RE.test(body)) corsOriginLine = newLine;
    if (CORS_CREDENTIALS_RE.test(body)) corsCredentialsLine = newLine;
    if (SAME_SITE_NONE_RE.test(body)) sameSiteLine = newLine;
    if (SECURE_FALSE_RE.test(body)) secureFalseLine = newLine;
    if (PROD_RE.test(body)) prodLine = newLine;
    if (DEBUG_TRUE_RE.test(body)) debugLine = newLine;

    if (
      corsOriginLine &&
      corsCredentialsLine &&
      pushFinding(
        findings,
        seen,
        path,
        Math.max(corsOriginLine, corsCredentialsLine),
        "wildcard-cors-credentials",
        maxFindings,
      )
    ) {
      return findings;
    }

    if (
      sameSiteLine &&
      secureFalseLine &&
      pushFinding(
        findings,
        seen,
        path,
        Math.max(sameSiteLine, secureFalseLine),
        "insecure-cookie",
        maxFindings,
      )
    ) {
      return findings;
    }

    if (
      prodLine &&
      debugLine &&
      pushFinding(
        findings,
        seen,
        path,
        Math.max(prodLine, debugLine),
        "prod-debug",
        maxFindings,
      )
    ) {
      return findings;
    }

    if (
      (OPEN_INGRESS_RE.test(body) || HOST_NETWORK_RE.test(body)) &&
      pushFinding(findings, seen, path, newLine, "open-ingress", maxFindings)
    ) {
      return findings;
    }
    if (
      PUBLIC_BUCKET_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "public-bucket", maxFindings)
    ) {
      return findings;
    }
    if (
      TLS_DISABLED_RE.test(body) &&
      pushFinding(
        findings,
        seen,
        path,
        newLine,
        "tls-verification-disabled",
        maxFindings,
      )
    ) {
      return findings;
    }
    if (
      HARDCODED_URL_RE.test(body) &&
      pushFinding(
        findings,
        seen,
        path,
        newLine,
        "hardcoded-service-url",
        maxFindings,
      )
    ) {
      return findings;
    }
    if (
      PRIVILEGED_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "privileged-container", maxFindings)
    ) {
      return findings;
    }
    if (
      PRIVILEGE_ESCALATION_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "privilege-escalation", maxFindings)
    ) {
      return findings;
    }
    if (
      HOST_PID_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "host-pid-namespace", maxFindings)
    ) {
      return findings;
    }
    if (
      HOST_IPC_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "host-ipc-namespace", maxFindings)
    ) {
      return findings;
    }
    if (
      RUN_AS_ROOT_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "run-as-root", maxFindings)
    ) {
      return findings;
    }
    if (
      RUN_AS_UID_ZERO_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "run-as-root-uid", maxFindings)
    ) {
      return findings;
    }
    if (
      WRITABLE_ROOTFS_RE.test(body) &&
      pushFinding(
        findings,
        seen,
        path,
        newLine,
        "writable-root-filesystem",
        maxFindings,
      )
    ) {
      return findings;
    }
    if (
      UNMASKED_PROC_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "unmasked-proc-mount", maxFindings)
    ) {
      return findings;
    }
    if (
      UNENCRYPTED_STORAGE_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "unencrypted-storage", maxFindings)
    ) {
      return findings;
    }
    if (
      PUBLIC_DB_RE.test(body) &&
      pushFinding(
        findings,
        seen,
        path,
        newLine,
        "publicly-accessible-database",
        maxFindings,
      )
    ) {
      return findings;
    }
    if (
      IMDS_V1_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "imdsv1-allowed", maxFindings)
    ) {
      return findings;
    }
    if (
      WORLD_WRITABLE_RE.test(body) &&
      pushFinding(
        findings,
        seen,
        path,
        newLine,
        "world-writable-permissions",
        maxFindings,
      )
    ) {
      return findings;
    }
    if (
      DOCKER_ADD_REMOTE_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "docker-add-remote-url", maxFindings)
    ) {
      return findings;
    }
    if (
      DOCKER_LATEST_TAG_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "docker-image-latest-tag", maxFindings)
    ) {
      return findings;
    }
    if (
      DOCKER_ROOT_USER_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "docker-root-user", maxFindings)
    ) {
      return findings;
    }
    if (
      REMOTE_SHELL_PIPE_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "remote-shell-pipe", maxFindings)
    ) {
      return findings;
    }
    if (
      INSECURE_DOWNLOAD_FLAG_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "insecure-download-flag", maxFindings)
    ) {
      return findings;
    }
    if (
      SSH_PORT_EXPOSED_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "ssh-port-exposed", maxFindings)
    ) {
      return findings;
    }
    if (
      NPM_UNSAFE_PERM_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "npm-unsafe-perm", maxFindings)
    ) {
      return findings;
    }
    if (
      SUDO_IN_BUILD_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "sudo-in-build", maxFindings)
    ) {
      return findings;
    }
    if (
      HARDCODED_BUILD_SECRET_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "hardcoded-build-secret", maxFindings)
    ) {
      return findings;
    }
    if (
      INSECURE_PIP_INDEX_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "insecure-pip-index", maxFindings)
    ) {
      return findings;
    }
    if (
      DB_SSL_DISABLED_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "db-ssl-disabled", maxFindings)
    ) {
      return findings;
    }
    if (
      GIT_SSL_NO_VERIFY_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "git-ssl-no-verify", maxFindings)
    ) {
      return findings;
    }
    if (
      SSH_HOST_KEY_OFF_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "ssh-host-key-check-off", maxFindings)
    ) {
      return findings;
    }
    if (
      VERIFY_SSL_OFF_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "verify-ssl-off", maxFindings)
    ) {
      return findings;
    }
    if (
      VALIDATE_CERTS_OFF_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "validate-certs-off", maxFindings)
    ) {
      return findings;
    }
    if (
      TLS_SKIP_VERIFY_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "tls-skip-verify", maxFindings)
    ) {
      return findings;
    }
    if (
      TRUST_ALL_CERTS_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "trust-all-server-certs", maxFindings)
    ) {
      return findings;
    }
    if (
      SECCOMP_UNCONFINED_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "seccomp-unconfined-runtime", maxFindings)
    ) {
      return findings;
    }
    if (
      APPARMOR_UNCONFINED_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "apparmor-unconfined", maxFindings)
    ) {
      return findings;
    }
    if (
      USERNS_HOST_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "userns-host", maxFindings)
    ) {
      return findings;
    }
    if (
      IPC_HOST_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "ipc-host", maxFindings)
    ) {
      return findings;
    }
    if (
      CAP_ADD_ALL_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "cap-add-all", maxFindings)
    ) {
      return findings;
    }
    if (
      NO_NEW_PRIVILEGES_OFF_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "no-new-privileges-off", maxFindings)
    ) {
      return findings;
    }
    if (
      DOCKER_SOCKET_MOUNT_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "docker-socket-mount", maxFindings)
    ) {
      return findings;
    }
    if (
      HSTS_DISABLED_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "hsts-disabled", maxFindings)
    ) {
      return findings;
    }
    if (
      REFERRER_UNSAFE_URL_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "referrer-policy-leak", maxFindings)
    ) {
      return findings;
    }
    if (
      COOKIE_NOT_HTTPONLY_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "cookie-not-httponly", maxFindings)
    ) {
      return findings;
    }
    if (
      COOP_UNSAFE_NONE_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "coop-unsafe-none", maxFindings)
    ) {
      return findings;
    }
    if (
      XSS_PROTECTION_OFF_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "x-xss-protection-off", maxFindings)
    ) {
      return findings;
    }
    if (
      FRAME_OPTIONS_ALLOWALL_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "frame-options-allowall", maxFindings)
    ) {
      return findings;
    }

    newLine++;
  }

  return findings;
}

export async function scanIacMisconfig(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<IacMisconfigFinding[]> {
  const findings: IacMisconfigFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch || !isRelevantConfigPath(file.path)) continue;
    for (const finding of scanPatchForIacMisconfig(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
