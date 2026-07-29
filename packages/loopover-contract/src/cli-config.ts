/**
 * The on-disk loopover CLI config, resolved the same way by every bin that reads it (#9521).
 *
 * `@loopover/mcp` owns this file (it is what `loopover-mcp login` writes) and `@loopover/miner` reads
 * it, but the two are separately-installable CLIs on purpose -- installing AMS must not drag in the
 * MCP wrapper just to parse a config format. So the miner hand-copied the resolution and said so in a
 * header comment ("kept in sync by hand -- there is no shared module to import"). This is that module:
 * both packages already depend on @loopover/contract, so it is the one home both can reach.
 *
 * Everything here is PURE -- no node: imports, no I/O. That is not incidental: this package's tsconfig
 * sets `"types": []` precisely so a node builtin cannot compile here and then fail later in the
 * Cloudflare bundle, and the root entry is imported by the Worker. So the caller does the reading
 * (`existsSync`/`readFileSync`, `homedir`, `join`) and this module owns the POLICY -- the path
 * template, the name pattern, the API-URL precedence, the constants. Those are what actually drifted
 * between the two copies; the four lines of fs around them never did.
 *
 * Scope is the READ side only. Writing the config (profile create/switch/remove, redaction,
 * persistence) stays in `@loopover/mcp`, which is the only package that writes it.
 *
 * Named `cli-config`, NOT `local-config`: a common global-gitignore pattern (`local-config.*`) matches the
 * latter, and this file's first incarnation was silently dropped from every commit by exactly that -- the
 * repo built locally, and CI failed on a module that had never been committed. Do not rename it back.
 */

export const DEFAULT_LOOPOVER_API_URL = "https://api.loopover.ai";

/**
 * API URLs that used to be the shipped default. A config still naming one is a stale artifact of an
 * older install, not a deliberate override, so resolution SKIPS them rather than honoring them.
 */
export const LEGACY_LOOPOVER_API_URLS: ReadonlySet<string> = new Set([
  "https://gittensory-api.zeronode.workers.dev",
  "https://gittensory-api.aethereal.dev",
]);

export const DEFAULT_PROFILE_NAME = "default";

/** 1-64 chars, starting alphanumeric. The same pattern both bins validated against by hand. */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type LoopoverConfigProfile = {
  apiUrl?: unknown;
  session?: { token?: unknown } | null | undefined;
};

export type LoopoverConfig = {
  activeProfile?: unknown;
  profiles?: Record<string, LoopoverConfigProfile | undefined>;
  apiUrl?: unknown;
};

/**
 * The environment reads that steer config location. A plain object so no caller needs `process` --
 * and the index signature is what lets a caller pass `process.env` straight in (without it TS's
 * weak-type check rejects ProcessEnv, whose own properties are all index-signature entries).
 */
export type LoopoverConfigEnv = {
  readonly LOOPOVER_CONFIG_PATH?: string | undefined;
  readonly LOOPOVER_CONFIG_DIR?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly LOOPOVER_API_URL?: string | undefined;
  readonly [key: string]: string | undefined;
};

/**
 * Where the config lives: LOOPOVER_CONFIG_PATH wins outright; else LOOPOVER_CONFIG_DIR/config.json;
 * else the XDG location under the home directory.
 *
 * `join` and `homeDir` are injected rather than imported so this stays free of node:path/node:os --
 * callers pass node's own, which keeps Windows separators correct.
 */
export function loopoverConfigPath(
  env: LoopoverConfigEnv,
  deps: { join: (...segments: string[]) => string; homeDir: () => string },
): string {
  if (env.LOOPOVER_CONFIG_PATH) return env.LOOPOVER_CONFIG_PATH;
  if (env.LOOPOVER_CONFIG_DIR) return deps.join(env.LOOPOVER_CONFIG_DIR, "config.json");
  return deps.join(env.XDG_CONFIG_HOME || deps.join(deps.homeDir(), ".config"), "loopover", "config.json");
}

/**
 * The config a raw file body describes, or `{}` for any reason it cannot be understood (absent file,
 * malformed JSON, or a non-object top level). Never throws and never reports WHY: a missing config is
 * the normal state for a fresh install, and the failure paths must not leak the path or its contents.
 */
export function parseLoopoverConfig(body: string | null | undefined): LoopoverConfig {
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as LoopoverConfig) : {};
  } catch {
    return {};
  }
}

/** The canonical (trimmed, lowercased) spelling of a profile name, or null when it is not a legal one. */
export function canonicalProfileName(value: unknown): string | null {
  const name = String(value ?? "").trim().toLowerCase();
  return PROFILE_NAME_PATTERN.test(name) ? name : null;
}

/** The session token recorded for a profile, or null when that profile has never logged in. */
export function profileSessionToken(profile: LoopoverConfigProfile | undefined): string | null {
  const token = profile?.session?.token;
  return typeof token === "string" && token ? token : null;
}

/**
 * The API URL to call: LOOPOVER_API_URL, else the active profile's apiUrl, else the config's top-level
 * apiUrl, else the default -- skipping any LEGACY_LOOPOVER_API_URLS entry at every step.
 *
 * The fall-THROUGH matters and is the behavior the two copies had drifted on (#9521). @loopover/mcp
 * picked the profile apiUrl if present and fell straight to the default when it was legacy, so a stale
 * profile URL masked a perfectly good top-level override; @loopover/miner kept looking (#8854). The
 * miner's is correct -- a legacy value means "ignore this one," not "stop looking" -- so it is what
 * this shared resolver does for both.
 */
export function resolveLoopoverApiUrl(
  env: LoopoverConfigEnv,
  config: LoopoverConfig,
  profile: LoopoverConfigProfile | undefined,
): string {
  if (env.LOOPOVER_API_URL) return env.LOOPOVER_API_URL.replace(/\/+$/, "");
  for (const candidate of [profile?.apiUrl, config.apiUrl]) {
    if (typeof candidate === "string" && candidate.trim()) {
      const normalized = candidate.replace(/\/+$/, "");
      if (!LEGACY_LOOPOVER_API_URLS.has(normalized)) return normalized;
    }
  }
  return DEFAULT_LOOPOVER_API_URL;
}
