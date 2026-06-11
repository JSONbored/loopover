import { describe, expect, it } from "vitest";
import {
  commandAuthorizationAllowedRoles,
  commandAuthorizationNeedsMinerDetection,
  evaluateCommandAuthorization,
  normalizeCommandAuthorizationPolicy,
  summarizeCommandAuthorizationPolicy,
} from "../../src/settings/command-authorization";

describe("repo command authorization policy", () => {
  it("preserves secure defaults for maintainers, collaborators, and confirmed-miner PR authors", () => {
    expect(evaluateCommandAuthorization({ commandName: "preflight", commenterAssociation: "OWNER" })).toMatchObject({
      authorized: true,
      reason: "maintainer_invocation",
      actorKind: "maintainer",
    });
    expect(evaluateCommandAuthorization({ commandName: "preflight", commenterAssociation: "COLLABORATOR" })).toMatchObject({
      authorized: true,
      reason: "collaborator_invocation",
      actorKind: "maintainer",
    });
    expect(
      evaluateCommandAuthorization({
        commandName: "next-action",
        commenterLogin: "miner",
        pullRequestAuthorLogin: "miner",
        minerStatus: "confirmed",
      }),
    ).toMatchObject({ authorized: true, reason: "confirmed_miner_pr_author", actorKind: "author" });
    expect(evaluateCommandAuthorization({ commandName: "queue-summary", commenterLogin: "miner", pullRequestAuthorLogin: "miner", minerStatus: "confirmed" })).toMatchObject({
      authorized: false,
      reason: "maintainer_command_requires_maintainer",
    });
  });

  it("honors command overrides and avoids miner lookup when plain PR author is allowed", () => {
    const policy = normalizeCommandAuthorizationPolicy({ default: ["maintainer"], commands: { "next-action": ["pr_author"] } }).policy;
    expect(
      commandAuthorizationNeedsMinerDetection({
        policy,
        commandName: "next-action",
        commenterLogin: "author",
        pullRequestAuthorLogin: "author",
      }),
    ).toBe(false);
    expect(evaluateCommandAuthorization({ policy, commandName: "next-action", commenterLogin: "author", pullRequestAuthorLogin: "author" })).toMatchObject({
      authorized: true,
      reason: "allowed_pr_author",
      actorKind: "author",
      matchedRole: "pr_author",
    });
    expect(evaluateCommandAuthorization({ policy, commandName: "packet", commenterLogin: "author", pullRequestAuthorLogin: "author" })).toMatchObject({
      authorized: false,
      reason: "command_policy_denied",
    });
  });

  it("falls back to default roles for inherited object property command names", () => {
    for (const commandName of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(commandAuthorizationAllowedRoles(undefined, commandName)).toEqual(["maintainer", "collaborator", "confirmed_miner"]);
      expect(evaluateCommandAuthorization({ commandName, commenterAssociation: "OWNER" })).toMatchObject({
        authorized: true,
        reason: "maintainer_invocation",
        allowedRoles: ["maintainer", "collaborator", "confirmed_miner"],
      });
    }
  });

  it("warns on malformed policy and falls back to default command roles", () => {
    const nonObject = normalizeCommandAuthorizationPolicy("not-a-policy");
    expect(nonObject.warnings).toEqual(["commandAuthorization must be an object; using secure defaults."]);
    expect(nonObject.policy.default).toEqual(["maintainer", "collaborator", "confirmed_miner"]);

    const defaultOnly = normalizeCommandAuthorizationPolicy({ default: ["pr_author"] });
    expect(defaultOnly.warnings).toEqual([]);
    expect(defaultOnly.policy.default).toEqual(["pr_author"]);
    expect(defaultOnly.policy.commands["queue-summary"]).toEqual(["maintainer", "collaborator"]);

    const { policy, warnings } = normalizeCommandAuthorizationPolicy({
      default: ["unknown", "confirmed_miner"],
      commands: {
        "bad command": ["maintainer"],
        preflight: ["bogus"],
        blockers: "maintainer",
      },
    });
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(policy.default).toEqual(["confirmed_miner"]);
    expect(policy.commands.preflight).toEqual(["confirmed_miner"]);
    expect(policy.commands.blockers).toEqual(["confirmed_miner"]);
    expect(summarizeCommandAuthorizationPolicy(policy).commandOverrides.map((entry) => entry.command)).toContain("queue-summary");

    const malformedCommands = normalizeCommandAuthorizationPolicy({ commands: ["preflight"] });
    expect(malformedCommands.warnings).toContain("commandAuthorization.commands must be an object; using command defaults.");
    expect(malformedCommands.policy.commands["queue-summary"]).toEqual(["maintainer", "collaborator"]);
  });
});
