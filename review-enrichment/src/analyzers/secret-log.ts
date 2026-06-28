// Secrets-in-logs / PII-egress analyzer (#1507). Flags added lines that pass sensitive data INTO a logging or
// stdout sink — `console.log(req.headers.authorization)`, `logger.info(`token=${apiKey}`)`, `console.log(req)` —
// distinct from the hardcoded-secret scan (which inspects literal VALUES; this inspects the data FLOW into a
// sink). Pure compute, no network. Precision-first: string-literal *messages* are stripped before matching, so
// `console.log("password reset")` is NOT flagged — a hit requires a sensitive name used as CODE (property access,
// a `${…}` interpolation, or a dumped request object). Line-cited via hunk headers, mirroring the other analyzers.
import type { EnrichRequest, SecretLogFinding } from "../types.js";

const MAX_FINDINGS = 25; // keep the brief bounded
const MAX_LINE_CHARS = 2000; // skip pathologically long lines (defensive)

// All matchers below are FLAT alternations (no group is itself quantified), so each is linear-time — the analyzer
// can never be the DoS class it sits beside (#1503). Logging / stdout sinks:
const SINK_RE =
  /\b(?:console|logger|log|winston|pino|bunyan)\s*\.\s*(?:log|info|warn|error|debug|trace|fatal|verbose|silly)\s*\(|\bprocess\s*\.\s*std(?:out|err)\s*\.\s*write\s*\(/;

// Sensitive names, matched only against CODE (after string messages are stripped) so a hit means the value is
// actually referenced, not merely named in a log message.
const SECRET_RE =
  /\b(?:passwords?|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|auth[_-]?token|bearer[_-]?token|private[_-]?key|credentials?|session[_-]?token|set[_-]?cookie)\b/i;
const PII_RE =
  /\b(?:ssn|social[_-]?security(?:[_-]?number)?|credit[_-]?card(?:[_-]?number)?|card[_-]?number|cvv|cvc|passport[_-]?(?:no|number)?|tax[_-]?id|national[_-]?id|date[_-]?of[_-]?birth)\b/i;
// A whole request/session object — or one of its sensitive sub-objects (headers/body/cookies/session/auth) —
// dumped into the sink. Innocuous scalar fields (`req.method`, `req.url`, `req.path`) are deliberately excluded to
// keep the signal high, and the object must be referenced as code so `console.log("request received")` is not a hit.
const REQUEST_OBJECT_RE =
  /\b(?:req|request)\s*(?:\)|\.\s*(?:headers|body|cookies|session|auth|rawheaders)\b)|\b(?:headers|session|cookies)\s*(?:\)|\.\s*[\w$])/i;

/** Blank out string-literal MESSAGE content (keeping `${…}` interpolation bodies, which are real code) in a single
 *  linear pass — no regex, so it can never backtrack. Lets the matchers above run against code, not log prose. */
export function codeOnly(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      i++;
      while (i < n && s[i] !== c) {
        if (s[i] === "\\") i++;
        i++;
      }
      i++; // closing quote
      out += " ";
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && s[i] !== "`") {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === "$" && s[i + 1] === "{") {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (s[i] === "{") depth++;
            else if (s[i] === "}") depth--;
            if (depth > 0) out += s[i];
            i++;
          }
          continue;
        }
        i++; // ordinary template-literal char — drop it
      }
      i++; // closing backtick
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function sinkLabel(match: string): string {
  return match.replace(/\s+/g, "").replace(/\($/, "");
}

/** Classify one line: does it pass sensitive data into a log/stdout sink? Returns the sink + category, or null. */
export function detectSecretLog(
  line: string,
): { sink: string; category: SecretLogFinding["category"] } | null {
  const m = SINK_RE.exec(line);
  if (!m) return null;
  const code = codeOnly(line.slice(m.index + m[0].length));
  if (SECRET_RE.test(code))
    return { sink: sinkLabel(m[0]), category: "secret" };
  if (PII_RE.test(code)) return { sink: sinkLabel(m[0]), category: "pii" };
  if (REQUEST_OBJECT_RE.test(code))
    return { sink: sinkLabel(m[0]), category: "request-object" };
  return null;
}

/** Scan one file patch's added lines for sensitive-data-into-a-sink, line-cited via hunk headers. Pure. */
type SecretLogScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

function* patchLines(patch: string): Generator<string> {
  // Stream by patch line so large diffs do not require an intermediate split array; abort is sampled per line below.
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

export function scanPatchForSecretLog(
  path: string,
  patch: string,
  limits: SecretLogScanLimits = {},
): SecretLogFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const findings: SecretLogFinding[] = [];
  let newLine = 0;
  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const hit = detectSecretLog(body);
        if (hit) {
          findings.push({
            file: path,
            line: newLine,
            sink: hit.sink,
            category: hit.category,
          });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's added lines for secrets/PII reaching a log or stdout sink. */
export async function scanSecretLog(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<SecretLogFinding[]> {
  const findings: SecretLogFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForSecretLog(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      // The per-file scan is capped to the remaining budget; keep this as a final invariant if that scanner changes.
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
