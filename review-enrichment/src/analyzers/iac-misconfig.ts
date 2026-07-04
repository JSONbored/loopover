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
  /\brejectUnauthorized\b[\s"'=:,-]*false\b|\bverify\s*=\s*False\b|\bssl_verify\b[\s"'=:,-]*false\b|\binsecureSkipTLSVerify\b[\s"'=:,-]*true\b|\bskipTLSVerify\b[\s"'=:,-]*true\b|\bNODE_TLS_REJECT_UNAUTHORIZED\b[\s"'=:,-]*["']?0\b/i;
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
