// Hardcoded-URL / raw-endpoint analyzer (#2027). Flags absolute HTTP(S) URLs and IP:port endpoints newly
// added in non-test, non-config source — often environment leakage or a value that should come from config.
// Distinct from the secret scanner (no credential); this is a portability/config-hygiene signal. Pure compute
// over added lines, no network. Hostnames are redacted/truncated in findings — never full paths or queries.
import type { EnrichRequest, HardcodedUrlFinding } from "../types.js";
import { isMagicNumberSourcePath } from "./magic-number.js";
import { DEFAULT_MAX_FINDINGS, DEFAULT_MAX_LINE_CHARS } from "./limits.js";
import { isBasicCommentLine } from "./diff-lines.js";

const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const MAX_LINE_CHARS = DEFAULT_MAX_LINE_CHARS;
const MAX_HOST_CHARS = 40;

const CONFIG_PATH_RE =
  /(?:^|\/)(?:docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|values(?:\.[^/]+)?\.ya?ml|\.env(?:\.[^/]+)?|.*\.(?:tf|tfvars|hcl|ya?ml|json|toml|ini|conf|env)|Dockerfile(?:\.[^/]+)?|nginx[^/]*\.conf)$/i;

const HTTP_URL_RE = /https?:\/\/[^\s'"\`<>]+/gi;
const IP_ENDPOINT_RE = /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/g;

const ALLOWLISTED_HOSTS = new Set(["localhost", "127.0.0.1", "example.com"]);

function isConfigPath(path: string): boolean {
  return CONFIG_PATH_RE.test(path);
}

function isScannablePath(path: string): boolean {
  return isMagicNumberSourcePath(path) && !isConfigPath(path);
}

function redactHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower.length <= MAX_HOST_CHARS) return lower;
  return `${lower.slice(0, MAX_HOST_CHARS - 3)}...`;
}

function isAllowlistedHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (ALLOWLISTED_HOSTS.has(lower)) return true;
  if (lower.endsWith(".example.com")) return true;
  return false;
}

function hostFromHttpUrl(url: string): string {
  const match = /^https?:\/\/([^/?#:]+)(?::\d+)?/i.exec(url);
  return match?.[1] ?? url;
}

// Layers the shell/Python `#` and HTML `<!--` comment forms on top of the shared `isBasicCommentLine` base
// (#4611) — this analyzer scans non-TS source (Dockerfiles, shell scripts, YAML) where `#` is a real comment
// marker, unlike the shared base's TS/JS-only `//`/`/* `/`*` forms.
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return isBasicCommentLine(line) || /^(?:#|<!--)/.test(trimmed);
}

function isImportLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^(?:import\b|from\b|#include\b|require\s*\(|use\s+\w+::)/.test(trimmed);
}

/** Classify one added line for a hardcoded URL or IP endpoint, or null. Pure. */
export function detectHardcodedUrl(
  line: string,
): { kind: HardcodedUrlFinding["kind"]; host: string } | null {
  if (isCommentLine(line) || isImportLine(line)) return null;

  HTTP_URL_RE.lastIndex = 0;
  const urlMatch = HTTP_URL_RE.exec(line);
  if (urlMatch) {
    const host = hostFromHttpUrl(urlMatch[0]);
    if (!isAllowlistedHost(host)) {
      return { kind: "http-url", host: redactHost(host) };
    }
  }

  IP_ENDPOINT_RE.lastIndex = 0;
  const ipMatch = IP_ENDPOINT_RE.exec(line);
  if (ipMatch) {
    const host = ipMatch[0].split(":")[0] ?? ipMatch[0];
    if (!isAllowlistedHost(host)) {
      return { kind: "ip-endpoint", host: redactHost(host) };
    }
  }

  return null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for hardcoded URLs/endpoints, line-cited via hunk headers. Pure. */
export function scanPatchForHardcodedUrl(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): HardcodedUrlFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isScannablePath(path)) return [];
  const findings: HardcodedUrlFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const hit = detectHardcodedUrl(body);
        if (hit) {
          findings.push({ file: path, line: newLine, kind: hit.kind, host: hit.host });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed scannable file's added lines for hardcoded endpoints. */
export async function scanHardcodedUrl(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<HardcodedUrlFinding[]> {
  const findings: HardcodedUrlFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForHardcodedUrl(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
