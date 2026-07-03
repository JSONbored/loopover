import { createPrivateKey } from "node:crypto";

export type SelfHostPreflightProblem = {
  var: string;
  message: string;
};

export type SelfHostPreflightResult =
  | { ok: true; problems: [] }
  | { ok: false; problems: SelfHostPreflightProblem[] };

type SelfHostPreflightEnv = Record<string, string | undefined>;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isBareHttpsOrigin(value: string): boolean {
  const url = parsedUrl(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    url.hostname.length > 0 &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
}

function isRedisUrl(value: string): boolean {
  const url = parsedUrl(value);
  return (
    url !== null &&
    (url.protocol === "redis:" || url.protocol === "rediss:") &&
    url.hostname.length > 0
  );
}

function isPostgresDatabaseUrl(value: string): boolean {
  const url = parsedUrl(value);
  if (url === null) return false;
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  const hasConnectionTarget =
    url.hostname.length > 0 || Boolean(url.searchParams.get("host")?.trim());
  const hasDatabaseName = url.pathname.length > 1;
  return hasConnectionTarget && hasDatabaseName;
}

function isGitHubAppId(value: string): boolean {
  return /^\d+$/.test(value);
}

function isGitHubAppPrivateKey(value: string): boolean {
  try {
    return createPrivateKey(value.replace(/\\n/g, "\n")).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

function addProblem(
  problems: SelfHostPreflightProblem[],
  name: string,
  message: string,
): void {
  problems.push({ var: name, message });
}

// Codex security finding: `.env.selfhost.example` / `.env.example` ship these EXACT literal placeholder
// values for high-privilege secrets (the webhook HMAC secret, plus the static API/MCP/internal bearer
// tokens). An operator who copies the starter to `.env` and misses "fill in the placeholders" runs an
// instance with a PUBLICLY KNOWN webhook secret (forgeable signatures) and PUBLICLY KNOWN bearer tokens
// (GITTENSORY_API_TOKEN bypasses app-role + per-repo write checks; INTERNAL_JOB_TOKEN gates internal
// routes) -- silently, with no error. Reject these exact strings at boot rather than trusting every
// operator to have actually edited the file.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "change-this-long-random-value",
  "change-this-32-byte-random-token",
]);

// A generated random secret (openssl rand -hex 32 = 64 chars, or base64 32 bytes ~= 44 chars) is always
// far longer than this; a human-typed guess or a short password essentially never reaches it. Not a
// substitute for the exact-match blocklist above (a placeholder could in principle be long), but catches
// the much broader class of "technically non-blank, not actually a secret."
const MIN_SECRET_LENGTH = 20;

const CRITICAL_SECRET_VARS = [
  "GITHUB_WEBHOOK_SECRET",
  "GITTENSORY_API_TOKEN",
  "GITTENSORY_MCP_TOKEN",
  "INTERNAL_JOB_TOKEN",
  "SELFHOST_SETUP_TOKEN",
] as const;

/** Validate one critical secret's STRENGTH (never its presence -- callers decide whether a given var is
 *  required in the current deployment mode). Returns null when the value is fine to use. Never echoes the
 *  supplied value back in the message: an unsafe secret is exactly the value that must not appear in logs. */
function criticalSecretProblem(name: string, value: string): string | null {
  if (KNOWN_PLACEHOLDER_SECRETS.has(value))
    return `${name} is still set to the placeholder value shipped in .env.selfhost.example / .env.example. Generate a real random secret (e.g. \`openssl rand -hex 32\`) before running this instance.`;
  if (value.length < MIN_SECRET_LENGTH)
    return `${name} is too short (${value.length} chars, minimum ${MIN_SECRET_LENGTH}) to be a safe secret. Generate a real random value (e.g. \`openssl rand -hex 32\`).`;
  return null;
}

function checkCriticalSecrets(
  problems: SelfHostPreflightProblem[],
  env: SelfHostPreflightEnv,
): void {
  const seenValues = new Map<string, string>(); // value -> first var name that used it
  for (const name of CRITICAL_SECRET_VARS) {
    const value = nonBlank(env[name]);
    if (!value) continue; // presence is each caller's own concern; this only judges strength when SET
    const problem = criticalSecretProblem(name, value);
    if (problem) {
      addProblem(problems, name, problem);
      continue;
    }
    const firstSeenBy = seenValues.get(value);
    if (firstSeenBy)
      addProblem(
        problems,
        name,
        `${name} must not reuse the same value as ${firstSeenBy} — each credential grants a distinct role, and a shared value lets one leaked/forged credential impersonate every role that reuses it.`,
      );
    else seenValues.set(value, name);
  }
}

export function preflightEnv(env: SelfHostPreflightEnv): SelfHostPreflightResult {
  const problems: SelfHostPreflightProblem[] = [];

  const redisUrl = nonBlank(env.REDIS_URL);
  if (!redisUrl || !isRedisUrl(redisUrl))
    addProblem(
      problems,
      "REDIS_URL",
      "Set REDIS_URL to the redis:// or rediss:// connection URL used for shared transient review state.",
    );

  const githubAppId = nonBlank(env.GITHUB_APP_ID);
  const githubAppPrivateKey = nonBlank(env.GITHUB_APP_PRIVATE_KEY);
  const hasPartialGitHubApp = Boolean(githubAppId || githubAppPrivateKey);
  if (hasPartialGitHubApp && !(githubAppId && githubAppPrivateKey)) {
    if (!githubAppId)
      addProblem(
        problems,
        "GITHUB_APP_ID",
        "Set GITHUB_APP_ID when configuring a GitHub App private key.",
      );
    if (!githubAppPrivateKey)
      addProblem(
        problems,
        "GITHUB_APP_PRIVATE_KEY",
        "Set GITHUB_APP_PRIVATE_KEY when configuring a GitHub App ID.",
      );
  }
  if (githubAppId && githubAppPrivateKey) {
    if (!isGitHubAppId(githubAppId))
      addProblem(
        problems,
        "GITHUB_APP_ID",
        "Set GITHUB_APP_ID to the numeric GitHub App ID.",
      );
    if (!isGitHubAppPrivateKey(githubAppPrivateKey))
      addProblem(
        problems,
        "GITHUB_APP_PRIVATE_KEY",
        "Set GITHUB_APP_PRIVATE_KEY to the PEM private key for the configured GitHub App.",
      );
  }

  const hasOrbBroker = Boolean(nonBlank(env.ORB_ENROLLMENT_SECRET));
  if (!hasPartialGitHubApp && !hasOrbBroker) {
    if (!nonBlank(env.SELFHOST_SETUP_TOKEN))
      addProblem(
        problems,
        "SELFHOST_SETUP_TOKEN",
        "Set SELFHOST_SETUP_TOKEN before using the first-run setup wizard.",
      );
    const publicApiOrigin = nonBlank(env.PUBLIC_API_ORIGIN);
    if (!publicApiOrigin || !isBareHttpsOrigin(publicApiOrigin))
      addProblem(
        problems,
        "PUBLIC_API_ORIGIN",
        "Set PUBLIC_API_ORIGIN to the public HTTPS origin that receives GitHub App setup callbacks.",
      );
  }

  const databaseUrl = nonBlank(env.DATABASE_URL);
  if (databaseUrl && !isPostgresDatabaseUrl(databaseUrl))
    addProblem(
      problems,
      "DATABASE_URL",
      "Set DATABASE_URL to a valid postgres:// URL with a database name, or leave it unset to use the SQLite backend.",
    );

  checkCriticalSecrets(problems, env);

  return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems };
}

export function formatSelfHostPreflightError(problems: SelfHostPreflightProblem[]): string {
  return [
    "Self-host environment preflight failed:",
    ...problems.map((problem) => `- ${problem.var}: ${problem.message}`),
  ].join("\n");
}

export function assertSelfHostPreflight(env: SelfHostPreflightEnv): void {
  const result = preflightEnv(env);
  if (!result.ok) throw new Error(formatSelfHostPreflightError(result.problems));
}
