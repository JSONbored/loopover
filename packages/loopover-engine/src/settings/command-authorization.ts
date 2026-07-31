import type { CommandAuthorizationRole, RepositoryCommandAuthorizationPolicy } from "../types/manifest-deps-types.js";

export const DEFAULT_COMMAND_AUTHORIZATION_POLICY: RepositoryCommandAuthorizationPolicy = {
  default: ["maintainer", "collaborator", "confirmed_miner"],
  commands: {
    "queue-summary": ["maintainer", "collaborator"],
    "confirmed-miners": ["maintainer", "collaborator"],
    "review-now": ["maintainer", "collaborator"],
    "needs-author": ["maintainer", "collaborator"],
    "duplicate-clusters": ["maintainer", "collaborator"],
    "burden-forecast": ["maintainer", "collaborator"],
    "intake-health": ["maintainer", "collaborator"],
    "outcome-patterns": ["maintainer", "collaborator"],
    "noise-report": ["maintainer", "collaborator"],
    "gate-override": ["maintainer", "collaborator"],
    plan: ["maintainer", "collaborator"],
    // #4595/#5084: chat is Ollama-only grounded LLM generation, a materially larger surface than ask's
    // deterministic-only answer, so v1 started maintainer/collaborator-only. #5084 widens this to the PR's
    // OWN author (never an arbitrary commenter on someone else's PR) -- but ONLY when commandRateLimitPolicy
    // is "hold" for the repo, enforced in evaluateCommandAuthorization below, not just by operator convention.
    // Explicit registration here (rather than falling through to `default`) also activates the
    // MAINTAINER_ONLY_DEFAULT_COMMANDS clamp in normalizeCommandRoleList, so a self-hoster can't yml
    // themselves into "any confirmed_miner" or similar widening beyond what's shipped here.
    chat: ["maintainer", "collaborator", "pr_author"],
    // #1960 PR control-surface verbs. "review" is deliberately widenable to confirmed_miner (same self-rerun
    // precedent already applied to review-now, #824) — a confirmed miner may re-trigger review on their own PR.
    // The rest (pause/resume/resolve/configuration/explain) are conservative maintainer/collaborator-only
    // defaults out of the box; a maintainer who wants to widen them can do so via commandAuthorization overrides.
    review: ["maintainer", "collaborator", "confirmed_miner"],
    pause: ["maintainer", "collaborator"],
    resume: ["maintainer", "collaborator"],
    resolve: ["maintainer", "collaborator"],
    configuration: ["maintainer", "collaborator"],
    explain: ["maintainer", "collaborator"],
    // #4195 (part of the #4189 E2E-test-generation epic): deliberately NARROWER than every command above --
    // "maintainer" ONLY, excluding "collaborator" and "confirmed_miner". This command can write real content
    // (a generated test) attributed to the PR; a repo could grant a contributor/miner collaborator-level
    // push access, and that tier must not be able to invoke test generation for their own scored PR (the
    // exact loophole a click-to-generate button would otherwise open). The existing
    // `maintainer_command_requires_maintainer` guard below already denies the PR's own author when they
    // don't independently hold the `maintainer` role, so no bespoke pr_author check is needed here.
    "generate-tests": ["maintainer"],
  },
};

// #9998: freeze the security vocabulary at runtime -- the object, its `default` array, its `commands` record,
// and every role array inside it -- so a future aliasing regression fails loudly (a strict-mode TypeError on
// the offending `push`) instead of silently widening a command for every repo in the isolate. Values are
// unchanged; normalizeCommandAuthorizationPolicy always hands callers a fresh deep copy to mutate.
for (const roles of Object.values(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands)) Object.freeze(roles);
Object.freeze(DEFAULT_COMMAND_AUTHORIZATION_POLICY.default);
Object.freeze(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands);
Object.freeze(DEFAULT_COMMAND_AUTHORIZATION_POLICY);

const COMMAND_AUTHORIZATION_ROLES = new Set<CommandAuthorizationRole>(["maintainer", "collaborator", "pr_author", "confirmed_miner"]);
// Roles that may remain configured on a maintainer-only command. The clamp drops only the spoofable
// plain `pr_author` role; `confirmed_miner` survives so a detected miner can self-trigger reruns (#824).
const MAINTAINER_COMMAND_AUTHORIZATION_ROLES = new Set<CommandAuthorizationRole>(["maintainer", "collaborator", "confirmed_miner"]);
const MAINTAINER_ONLY_DEFAULT_COMMANDS = new Set(Object.keys(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands));
// #5084: commands where a `pr_author` match is only actually granted when commandRateLimitPolicy is "hold" for
// the repo -- checked in evaluateCommandAuthorization. Currently just `chat` (Ollama-only LLM generation);
// deliberately a narrow, explicit allowlist rather than inferring this from isAiCostBearingCommand, so widening
// it to another command later is a deliberate one-line addition, not an implicit side effect of an unrelated set.
const PR_AUTHOR_RATE_LIMITED_COMMANDS = new Set(["chat"]);

export type CommandAuthorizationDecision = {
  authorized: boolean;
  reason: string;
  actorKind: "maintainer" | "author" | "none";
  matchedRole: CommandAuthorizationRole | null;
  allowedRoles: CommandAuthorizationRole[];
};

export function normalizeCommandAuthorizationPolicy(input: unknown): { policy: RepositoryCommandAuthorizationPolicy; warnings: string[] } {
  const warnings: string[] = [];
  if (!isRecord(input)) {
    if (input !== null && input !== undefined) warnings.push("commandAuthorization must be an object; using secure defaults.");
    return { policy: clonePolicy(DEFAULT_COMMAND_AUTHORIZATION_POLICY), warnings };
  }

  const defaultRoles = normalizeRoleList(input.default, DEFAULT_COMMAND_AUTHORIZATION_POLICY.default, "default", warnings);
  // #9998: DEEP-copy the default command arrays, not a shallow spread. A shallow `{ ...DEFAULT...commands }`
  // shares every un-overridden command's role array with the module-level (now frozen) default, so a caller
  // that mutated a returned array would corrupt the security vocabulary for every repo in the isolate. This
  // reuses `clonePolicy` -- the same deep copy the non-record exit already returns -- so both paths hand back
  // arrays the caller solely owns.
  const commands: Record<string, CommandAuthorizationRole[]> = clonePolicy(DEFAULT_COMMAND_AUTHORIZATION_POLICY).commands;
  if (input.commands !== undefined) {
    if (isRecord(input.commands)) {
      for (const [command, roles] of Object.entries(input.commands)) {
        const commandName = command.trim().toLowerCase();
        if (!/^[a-z][a-z-]{0,63}$/.test(commandName)) {
          warnings.push(`Ignored malformed command authorization key: ${command.slice(0, 64)}`);
          continue;
        }
        commands[commandName] = normalizeCommandRoleList(commandName, normalizeRoleList(roles, defaultRoles, commandName, warnings), warnings);
      }
    } else {
      warnings.push("commandAuthorization.commands must be an object; using command defaults.");
    }
  }

  return { policy: { default: defaultRoles, commands }, warnings };
}

export function commandAuthorizationAllowedRoles(policy: RepositoryCommandAuthorizationPolicy | null | undefined, commandName: string): CommandAuthorizationRole[] {
  const normalized = normalizeCommandAuthorizationPolicy(policy).policy;
  // Policy command keys are stored normalized (trimmed + lowercased) by normalizeCommandAuthorizationPolicy,
  // so the lookup MUST normalize the probe too. A raw mixed-case name (e.g. "Gate-Override") otherwise misses
  // its restrictive override and silently falls back to the permissive default — under-stating the restriction.
  const key = normalizeCommandName(commandName);
  const commandRoles = Object.hasOwn(normalized.commands, key) ? normalized.commands[key] : undefined;
  return dedupeRoles(commandRoles ?? normalized.default);
}

function normalizeCommandName(commandName: string): string {
  return commandName.trim().toLowerCase();
}

export function commandAuthorizationNeedsMinerDetection(args: {
  policy?: RepositoryCommandAuthorizationPolicy | null | undefined;
  commandName: string;
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
  pullRequestAuthorLogin?: string | null | undefined;
}): boolean {
  const allowedRoles = commandAuthorizationAllowedRoles(args.policy, args.commandName);
  if (!allowedRoles.includes("confirmed_miner")) return false;
  if (!isSameLogin(args.commenterLogin, args.pullRequestAuthorLogin)) return false;
  const rolesWithoutMiner = actorRoles({ ...args, minerStatus: undefined });
  return !rolesWithoutMiner.some((role) => allowedRoles.includes(role));
}

export function evaluateCommandAuthorization(args: {
  policy?: RepositoryCommandAuthorizationPolicy | null | undefined;
  commandName: string;
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
  pullRequestAuthorLogin?: string | null | undefined;
  minerStatus?: "confirmed" | "not_found" | "unavailable" | undefined;
  /** #5084: required (must be `"hold"`) for a bare `pr_author` match to actually authorize a command in
   *  {@link PR_AUTHOR_RATE_LIMITED_COMMANDS} (currently just `chat`) -- unset/`"off"` denies exactly as if
   *  `pr_author` weren't in the allowed-roles list at all, so a repo that hasn't turned on rate limiting
   *  never grants contributor chat access no matter what `chat`'s configured roles say. */
  commandRateLimitPolicy?: "off" | "hold" | undefined;
  /** #5092: ALSO required (must be `true`) for a bare `pr_author` match to authorize a command in
   *  {@link PR_AUTHOR_RATE_LIMITED_COMMANDS} -- the per-PR rate-limit counter (`repoFullName#issueNumber#command`)
   *  never resets or checks PR state, so without this a contributor could keep a fresh allowance forever by
   *  reopening/reusing a closed PR or spamming cheap draft PRs. Caller-computed (e.g. `pr.state === "open" &&
   *  !pr.isDraft`) so this function doesn't need to know GitHub's own state-string conventions. Unset/`false`
   *  denies exactly like a missing rate-limit policy -- maintainers/collaborators are unaffected regardless
   *  (this bounds the less-trusted pr_author tier, not already-trusted roles). */
  pullRequestOpenAndNotDraft?: boolean | undefined;
}): CommandAuthorizationDecision {
  const allowedRoles = commandAuthorizationAllowedRoles(args.policy, args.commandName);
  const roles = actorRoles(args);
  const matchedRole = roles.find((role) => allowedRoles.includes(role)) ?? null;
  const prAuthorGatedCommand = matchedRole === "pr_author" && PR_AUTHOR_RATE_LIMITED_COMMANDS.has(normalizeCommandName(args.commandName));
  if (prAuthorGatedCommand && args.commandRateLimitPolicy !== "hold") {
    return { authorized: false, reason: "pr_author_requires_rate_limiting", actorKind: "author", matchedRole: null, allowedRoles };
  }
  if (prAuthorGatedCommand && args.pullRequestOpenAndNotDraft !== true) {
    return { authorized: false, reason: "pr_author_requires_open_pr", actorKind: "author", matchedRole: null, allowedRoles };
  }
  if (matchedRole) {
    return {
      authorized: true,
      reason: authorizationReason(matchedRole),
      actorKind: matchedRole === "maintainer" || matchedRole === "collaborator" ? "maintainer" : "author",
      matchedRole,
      allowedRoles,
    };
  }
  const ownPrAuthor = isSameLogin(args.commenterLogin, args.pullRequestAuthorLogin);
  if (ownPrAuthor && allowedRoles.includes("confirmed_miner")) {
    return {
      authorized: false,
      reason: args.minerStatus === "unavailable" || !args.minerStatus ? "miner_detection_unavailable" : "pr_author_not_confirmed_miner",
      actorKind: "author",
      matchedRole: null,
      allowedRoles,
    };
  }
  if (ownPrAuthor && MAINTAINER_ONLY_DEFAULT_COMMANDS.has(normalizeCommandName(args.commandName)) && allowedRoles.every((role) => role === "maintainer" || role === "collaborator")) {
    return { authorized: false, reason: "maintainer_command_requires_maintainer", actorKind: "author", matchedRole: null, allowedRoles };
  }
  return {
    authorized: false,
    reason: ownPrAuthor ? "command_policy_denied" : "not_maintainer_or_pr_author",
    actorKind: ownPrAuthor ? "author" : "none",
    matchedRole: null,
    allowedRoles,
  };
}

export function summarizeCommandAuthorizationPolicy(policy: RepositoryCommandAuthorizationPolicy | null | undefined): {
  defaultAllowed: CommandAuthorizationRole[];
  commandOverrides: Array<{ command: string; allowedRoles: CommandAuthorizationRole[] }>;
} {
  const normalized = normalizeCommandAuthorizationPolicy(policy).policy;
  return {
    defaultAllowed: normalized.default,
    commandOverrides: Object.entries(normalized.commands)
      .map(([command, allowedRoles]) => ({ command, allowedRoles }))
      .sort((left, right) => left.command.localeCompare(right.command)),
  };
}

function normalizeCommandRoleList(commandName: string, roles: CommandAuthorizationRole[], warnings: string[]): CommandAuthorizationRole[] {
  if (!MAINTAINER_ONLY_DEFAULT_COMMANDS.has(commandName)) return roles;

  // #5084: a role also survives the clamp if it's explicitly part of THIS command's own shipped default
  // (chat's own default now includes pr_author) -- so a maintainer restating or narrowing a command's own
  // default via yml never gets silently mangled, while every OTHER maintainer-only command whose own default
  // excludes pr_author still can't have it added via override (this is a per-command union, not a blanket
  // relaxation: the clamp still can't be conjured up on generate-tests/pause/etc.).
  /* v8 ignore next -- defensive: MAINTAINER_ONLY_DEFAULT_COMMANDS is derived from these keys, so a maintainer-only command always resolves a default list. */
  const commandOwnDefaultRoles = DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands[commandName] ?? [];
  const allowedClampRoles = new Set<CommandAuthorizationRole>([...MAINTAINER_COMMAND_AUTHORIZATION_ROLES, ...commandOwnDefaultRoles]);
  const maintainerRoles = roles.filter((role) => allowedClampRoles.has(role));
  if (maintainerRoles.length === roles.length) return roles;

  warnings.push(`Ignored author command authorization roles for maintainer-only command: ${commandName}.`);
  if (maintainerRoles.length > 0) return dedupeRoles(maintainerRoles);
  const defaultRoles = DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands[commandName];
  /* v8 ignore next -- defensive: MAINTAINER_ONLY_DEFAULT_COMMANDS is derived from these keys, so a maintainer-only command always resolves a default list. */
  return [...(defaultRoles ?? ["maintainer", "collaborator"])];
}

function actorRoles(args: {
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
  pullRequestAuthorLogin?: string | null | undefined;
  minerStatus?: "confirmed" | "not_found" | "unavailable" | undefined;
}): CommandAuthorizationRole[] {
  const roles: CommandAuthorizationRole[] = [];
  if (args.commenterAssociation === "OWNER" || args.commenterAssociation === "MEMBER") roles.push("maintainer");
  if (args.commenterAssociation === "COLLABORATOR") roles.push("collaborator");
  if (isSameLogin(args.commenterLogin, args.pullRequestAuthorLogin)) {
    roles.push("pr_author");
    if (args.minerStatus === "confirmed") roles.push("confirmed_miner");
  }
  return roles;
}

function normalizeRoleList(input: unknown, fallback: CommandAuthorizationRole[], label: string, warnings: string[]): CommandAuthorizationRole[] {
  if (!Array.isArray(input)) {
    if (input !== undefined) warnings.push(`commandAuthorization.${label} must be an array of roles; using fallback roles.`);
    return dedupeRoles(fallback);
  }
  const roles = input.filter((role): role is CommandAuthorizationRole => {
    const valid = typeof role === "string" && COMMAND_AUTHORIZATION_ROLES.has(role as CommandAuthorizationRole);
    if (!valid) warnings.push(`Ignored invalid command authorization role for ${label}.`);
    return valid;
  });
  if (roles.length === 0) {
    warnings.push(`commandAuthorization.${label} had no valid roles; using fallback roles.`);
    return dedupeRoles(fallback);
  }
  return dedupeRoles(roles);
}

function dedupeRoles(roles: CommandAuthorizationRole[]): CommandAuthorizationRole[] {
  return [...new Set(roles)];
}

function clonePolicy(policy: RepositoryCommandAuthorizationPolicy): RepositoryCommandAuthorizationPolicy {
  return { default: [...policy.default], commands: Object.fromEntries(Object.entries(policy.commands).map(([command, roles]) => [command, [...roles]])) };
}

function authorizationReason(role: CommandAuthorizationRole): string {
  if (role === "maintainer") return "maintainer_invocation";
  if (role === "collaborator") return "collaborator_invocation";
  if (role === "confirmed_miner") return "confirmed_miner_pr_author";
  return "allowed_pr_author";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}
