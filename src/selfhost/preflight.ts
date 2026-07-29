import { createPrivateKey } from "node:crypto";
import { CRON_INTERVAL_MIN_MS } from "./cron-alignment";
import { currentAnchorKey, parseAnchorPublicKeys } from "../review/ledger-anchor";
import { parseLedgerContentWaiver } from "../review/decision-record";

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

/**
 * Ledger anchoring (#9769) is OPT-IN, so "nothing configured" is deliberately not a problem. What IS a
 * problem is PARTIAL configuration, because it fails completely silently: runScheduledLedgerAnchor logs
 * `ledger_anchor_skipped_unconfigured` and returns (ledger-anchor-scheduler.ts), while the job keeps firing
 * every couple of minutes. An operator who set half the vars has no signal at all that anchoring never runs
 * -- and a self-host container DOES run the scheduler and DOES have a populated decision_ledger, so it is
 * genuinely one keypair away from working.
 *
 * The published-key checks call the real `parseAnchorPublicKeys`/`currentAnchorKey` rather than
 * re-validating the shape here, so preflight can never disagree with what the scheduler will actually do.
 */
/**
 * #9850: a malformed LOOPOVER_LEDGER_CONTENT_WAIVER fails CLOSED -- it waives nothing, which is the safe
 * direction but also a completely silent one. An operator who fat-fingers the range believes rows are
 * declared when they are not, and only finds out when the public endpoint keeps reporting a failure they
 * thought they had disclosed. Same reasoning as the anchor-config check below: the danger is not the unset
 * value, it is the set-but-ineffective one.
 */
function checkLedgerContentWaiverConfig(problems: SelfHostPreflightProblem[], env: SelfHostPreflightEnv): void {
  const raw = nonBlank(env["LOOPOVER_LEDGER_CONTENT_WAIVER"]);
  if (!raw) return;
  if (parseLedgerContentWaiver(raw) === null) {
    addProblem(
      problems,
      "LOOPOVER_LEDGER_CONTENT_WAIVER",
      'Set but unparseable, so NOTHING is waived and /v1/public/decision-ledger/verify will keep reporting the mismatches you meant to declare. Expected "<fromSeq>-<toSeq>:<reason>" with both bounds, fromSeq >= 1, toSeq >= fromSeq, and a non-empty reason.',
    );
  }
}

function checkLedgerAnchorConfig(problems: SelfHostPreflightProblem[], env: SelfHostPreflightEnv): void {
  const rawKeys = nonBlank(env["LOOPOVER_LEDGER_ANCHOR_KEYS"]);
  const privateKey = nonBlank(env["LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY"]);

  if (rawKeys && !privateKey) {
    addProblem(
      problems,
      "LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY",
      "LOOPOVER_LEDGER_ANCHOR_KEYS is set but the private half is not, so anchoring silently never runs. Set the P-256 PKCS8 private key, or unset LOOPOVER_LEDGER_ANCHOR_KEYS to disable anchoring.",
    );
  }
  if (privateKey && !rawKeys) {
    addProblem(
      problems,
      "LOOPOVER_LEDGER_ANCHOR_KEYS",
      "LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY is set but no public key list is published, so anchors would be unverifiable and anchoring silently never runs. Publish the matching key, or unset the private key to disable anchoring.",
    );
  }
  if (rawKeys) {
    const keys = parseAnchorPublicKeys(rawKeys);
    if (keys.length === 0) {
      addProblem(
        problems,
        "LOOPOVER_LEDGER_ANCHOR_KEYS",
        "No usable entries parsed. Expected a JSON array of { keyId, publicKeySpki, notBefore, notAfter }; malformed JSON and entries missing any required field are dropped silently at runtime.",
      );
    } else if (currentAnchorKey(keys) === null) {
      const current = keys.filter((key) => key.notAfter === null).length;
      addProblem(
        problems,
        "LOOPOVER_LEDGER_ANCHOR_KEYS",
        current === 0
          ? "No entry has notAfter: null, so there is no current signing key and anchoring silently never runs. Exactly one entry must be open-ended."
          : `${current} entries have notAfter: null. An ambiguous rotation fails closed rather than guessing which key signs, so anchoring silently never runs. Exactly one entry must be open-ended.`,
      );
    }
  }

  // The git backend is independently optional, but owner+repo without an installation id means job-dispatch
  // resolves `submitGit` to null and the backend is skipped without comment.
  const gitOwner = nonBlank(env["LOOPOVER_LEDGER_ANCHOR_GIT_OWNER"]);
  const gitRepo = nonBlank(env["LOOPOVER_LEDGER_ANCHOR_GIT_REPO"]);
  const installationId = nonBlank(env["LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID"]);
  if (gitOwner && gitRepo && !installationId) {
    addProblem(
      problems,
      "LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID",
      "A git anchor target is configured but no installation id is set, so no write token can be minted and the git backend is skipped silently. Set the installation id, or unset the git owner/repo.",
    );
  }
  if (installationId && !/^[1-9][0-9]*$/.test(installationId)) {
    addProblem(
      problems,
      "LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID",
      "Must be a positive integer; any other value resolves to no git submitter and the backend is skipped silently.",
    );
  }
  if ((gitOwner && !gitRepo) || (gitRepo && !gitOwner)) {
    addProblem(
      problems,
      gitOwner ? "LOOPOVER_LEDGER_ANCHOR_GIT_REPO" : "LOOPOVER_LEDGER_ANCHOR_GIT_OWNER",
      "A git anchor target needs BOTH owner and repo; with only one set the backend is skipped silently.",
    );
  }
}

function addProblem(
  problems: SelfHostPreflightProblem[],
  name: string,
  message: string,
): void {
  problems.push({ var: name, message });
}

// Codex security finding: reject the starter files' literal placeholder values at boot, rather than trusting
// every operator to have actually edited the file. An operator who copies a starter to `.env` and misses "fill
// in the placeholders" would otherwise run with a PUBLICLY KNOWN secret -- a forgeable webhook HMAC, or bearer
// tokens that bypass real checks (LOOPOVER_API_TOKEN bypasses app-role + per-repo write checks;
// INTERNAL_JOB_TOKEN gates internal routes) -- silently, with no error.
//
// What the starters ACTUALLY ship today (#6285 -- this comment used to claim both files ship literal values for
// the webhook secret and all three bearer tokens, which was never true of either). Every var below ships
// COMMENTED OUT in both files, so the hazard is what an operator finds when they uncomment one:
//   - `.env.selfhost.example`: all five are commented AND valueless (`# GITHUB_WEBHOOK_SECRET=`) -- uncommenting
//     yields a blank, which checkCriticalSecrets skips outright and which cannot be a publicly known value.
//   - `.env.example`: same, except SELFHOST_SETUP_TOKEN's commented line carries a literal
//     (`# SELFHOST_SETUP_TOKEN=change-this-long-random-value`). Uncommenting THAT -- the obvious way to turn the
//     first-run wizard on -- hands the operator a published token unless this set stops them.
// That literal is also the string most likely to reach a var that ships valueless: `.env.example` repeats it on
// POSTGRES_PASSWORD's commented line, so it reads like the house placeholder rather than one var's.
//
// Load-bearing for every var here, not just the one that ships it: this set is matched against whatever the
// operator SET, not against what the files ship. And at 29 chars the literal sails past MIN_SECRET_LENGTH below,
// so this exact-match set is the ONLY check that catches it.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "change-this-long-random-value",
  // Ships in neither starter today. Kept as defence-in-depth: this set is matched against whatever an operator
  // actually set, not against what the files ship, so retiring a once-published placeholder buys nothing.
  "change-this-32-byte-random-token",
]);

// A generated random secret (openssl rand -hex 32 = 64 chars, or base64 32 bytes ~= 44 chars) is always
// far longer than this; a human-typed guess or a short password essentially never reaches it. Not a
// substitute for the exact-match blocklist above (a placeholder could in principle be long), but catches
// the much broader class of "technically non-blank, not actually a secret."
const MIN_SECRET_LENGTH = 20;

const CRITICAL_SECRET_VARS = [
  "GITHUB_WEBHOOK_SECRET",
  "LOOPOVER_API_TOKEN",
  "LOOPOVER_MCP_TOKEN",
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

// #9157: a bare `Number(process.env.X ?? default)` at a call site turns a wrong-unit/wrong-type operator
// mistake ("2m", "120s", "120_000", a fraction, a negative number) into NaN — and NaN silently becomes a
// runaway (setTimeout/setInterval coerce NaN to 1ms) or a silent feature disable (a `> 0` gate on NaN is
// always false), with no boot-time signal either way. Unlike parsePositiveIntEnv (queue-common.ts), which is
// the RUNTIME defense-in-depth for the same knobs — it silently falls back to a safe default with a warn log
// so a running process degrades gracefully — this runs at BOOT and turns the identical bad value into a
// fatal preflight error: an operator who fat-fingers a unit suffix finds out immediately, from a clear error,
// rather than from a buried warn line or (worse) a live production runaway. Absence is always fine — presence
// is each var's own default's concern, mirrored in the call site's own fallback — this only judges a value
// the operator actually set.
function positiveInteger(
  problems: SelfHostPreflightProblem[],
  env: SelfHostPreflightEnv,
  name: string,
  min: number,
  max: number,
): void {
  const raw = nonBlank(env[name]);
  if (!raw) return;
  if (!/^\d+$/.test(raw)) {
    addProblem(
      problems,
      name,
      `Set ${name} to a plain positive integer — no unit suffix (e.g. "2m"/"120s"), no numeric separators ("120_000"), and no decimal point.`,
    );
    return;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    addProblem(problems, name, `Set ${name} to an integer between ${min} and ${max}.`);
  }
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

  // #9157: the numeric env knobs previously read with a bare `Number(process.env.X ?? default)` at their call
  // sites (src/server.ts) — a malformed value NaN's through to a runaway 1ms cron/setTimeout or a silently
  // disabled response cache with no boot-time signal. 0 is a valid, meaningful value for
  // GITHUB_CACHE_TTL_SECONDS ("disable the cache", server.ts's own documented convention) but NOT for
  // CRON_INTERVAL_MS (see CRON_INTERVAL_MIN_MS's own doc comment) or PORT (no TCP port is 0).
  positiveInteger(problems, env, "CRON_INTERVAL_MS", CRON_INTERVAL_MIN_MS, 24 * 60 * 60_000);
  positiveInteger(problems, env, "PORT", 1, 65_535);
  positiveInteger(problems, env, "GITHUB_CACHE_TTL_SECONDS", 0, 86_400);

  checkLedgerAnchorConfig(problems, env);
  checkLedgerContentWaiverConfig(problems, env);

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
