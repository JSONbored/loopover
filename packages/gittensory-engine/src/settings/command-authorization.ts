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
  },
};

const COMMAND_AUTHORIZATION_ROLES = new Set<CommandAuthorizationRole>(["maintainer", "collaborator", "pr_author", "confirmed_miner"]);
// Roles that may remain configured on a maintainer-only command. The clamp drops only the spoofable
// plain `pr_author` role; `confirmed_miner` survives so a detected miner can self-trigger reruns (#824).
const MAINTAINER_COMMAND_AUTHORIZATION_ROLES = new Set<CommandAuthorizationRole>(["maintainer", "collaborator", "confirmed_miner"]);
const MAINTAINER_ONLY_DEFAULT_COMMANDS = new Set(Object.keys(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands));

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
  const commands: Record<string, CommandAuthorizationRole[]> = { ...DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands };
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
}): CommandAuthorizationDecision {
  const allowedRoles = commandAuthorizationAllowedRoles(args.policy, args.commandName);
  const roles = actorRoles(args);
  const matchedRole = roles.find((role) => allowedRoles.includes(role)) ?? null;
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

  const maintainerRoles = roles.filter((role) => MAINTAINER_COMMAND_AUTHORIZATION_ROLES.has(role));
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
