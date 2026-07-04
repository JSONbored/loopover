import type { EnrichRequest, IacMisconfigFinding } from "../types.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const CONFIG_PATH_RE =
  /(?:^|\/)(?:docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|values(?:\.[^/]+)?\.ya?ml|\.env(?:\.[^/]+)?|.*\.(?:tf|ya?ml|json|toml|ini|conf|env)|Dockerfile(?:\.[^/]+)?|nginx[^/]*\.conf)$/i;

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

// Dockerfile build-security hardening (hadolint / checkov CKV_DOCKER_*). The uppercase instruction keywords
// (ADD/FROM/USER/EXPOSE) are Dockerfile-specific, so they do not fire on lowercase YAML/JSON keys; the
// flag/shell shapes are risky in any build/config file the path gate already admits.
const DOCKER_ADD_REMOTE_RE = /\bADD\s+(?:--\S+\s+)*https?:\/\/\S/;
const DOCKER_LATEST_TAG_RE = /\bFROM\s+(?:--\S+\s+)*\S+:latest\b/;
const DOCKER_ROOT_USER_RE = /\bUSER\s+(?:root|0)\b/;
// A remote download piped straight into a shell — the classic `curl … | sh` run-remote-code-at-build shape.
const REMOTE_SHELL_PIPE_RE =
  /\b(?:curl|wget)\b[^\n]*?\|\s*(?:sudo\s+)?(?:bash|zsh|ksh|dash|ash|sh)\b/;
// Build flags that disable download / TLS certificate verification (wget/apt/curl/pip).
const INSECURE_DOWNLOAD_FLAG_RE =
  /--(?:no-check-certificate|allow-unauthenticated|force-yes|trusted-host)\b/;
const SSH_PORT_EXPOSED_RE = /\bEXPOSE\s+(?:\d+(?:\/\w+)?\s+)*22(?:\/tcp)?\b/;
const NPM_UNSAFE_PERM_RE = /--unsafe-perm\b/;
// `sudo` invoked inside a RUN layer (privilege elevation during build). `RUN apt-get install sudo` does NOT
// match because sudo does not immediately follow `RUN`/`&&`.
const SUDO_IN_BUILD_RE = /\bRUN\s+sudo\s|&&\s*sudo\s/;
// A credential-shaped value hardcoded into an image layer via ENV/ARG WITH a value (build secrets persist in
// the image history). A bare `ARG DB_PASSWORD` (no `=value`) is a legitimate build-arg declaration and is skipped.
const HARDCODED_BUILD_SECRET_RE =
  /\b(?:ENV|ARG)\s+\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)\w*\s*=\s*\S/i;
// A package installer pointed at a plaintext-HTTP index (dependency-download MITM).
const INSECURE_PIP_INDEX_RE = /--(?:extra-)?index-url[=\s]+http:\/\//i;

// More Kubernetes Pod Security Standards (restricted profile) controls, completing the securityContext set
// above. Each is a single `key: <insecure-value>` line (or, for capabilities, an unambiguous capability name).
const HOST_PORT_RE = /\bhostPort\b[\s"'=:,-]*\d/;
// `hostPath` volume mount (restricted PSS forbids it). `\bhostPath\b` does NOT match the `hostPathType` sub-field
// (word boundary fails before `Type`); it matches the `hostPath:` volume key that maps a host directory in.
const HOST_PATH_RE = /\bhostPath\b\s*:/;
// A dangerous Linux capability added to the container. These names are capability-specific (they are not
// ordinary words/identifiers), so a bare occurrence in a config file is a reliable signal.
const ADDED_CAPABILITY_RE = /\b(?:SYS_ADMIN|NET_ADMIN|SYS_PTRACE|SYS_MODULE|SYS_RAWIO|DAC_READ_SEARCH|NET_RAW)\b/;
const SHARE_PROCESS_NS_RE = /\bshareProcessNamespace\b[\s"'=:,-]*true\b/;
const RUN_AS_GID_ZERO_RE = /\brunAsGroup\b[\s"'=:,-]*0\b/;
const FS_GROUP_ZERO_RE = /\bfsGroup\b[\s"'=:,-]*0\b/;
const WINDOWS_HOST_PROCESS_RE = /\bhostProcess\b[\s"'=:,-]*true\b/;
// seccompProfile `type: Unconfined` disables syscall filtering. The `Unconfined` value is k8s-specific
// (seccomp/AppArmor), so keying the generic `type` field on it does not over-match ordinary config.
const SECCOMP_UNCONFINED_RE = /\btype\b[\s"'=:,-]*["']?Unconfined\b/;

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
      HOST_PORT_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "host-port", maxFindings)
    ) {
      return findings;
    }
    if (
      HOST_PATH_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "host-path-volume", maxFindings)
    ) {
      return findings;
    }
    if (
      ADDED_CAPABILITY_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "added-linux-capability", maxFindings)
    ) {
      return findings;
    }
    if (
      SHARE_PROCESS_NS_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "share-process-namespace", maxFindings)
    ) {
      return findings;
    }
    if (
      RUN_AS_GID_ZERO_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "run-as-root-group", maxFindings)
    ) {
      return findings;
    }
    if (
      FS_GROUP_ZERO_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "root-fs-group", maxFindings)
    ) {
      return findings;
    }
    if (
      WINDOWS_HOST_PROCESS_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "windows-host-process", maxFindings)
    ) {
      return findings;
    }
    if (
      SECCOMP_UNCONFINED_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "seccomp-unconfined", maxFindings)
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
