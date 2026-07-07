// Mirror of the app suite pointed at the gittensory-engine copy so the extracted module owns its branch coverage (#2280).
import { describe, expect, it } from "vitest";
import {
  commandAuthorizationAllowedRoles,
  commandAuthorizationNeedsMinerDetection,
  evaluateCommandAuthorization,
  normalizeCommandAuthorizationPolicy,
  summarizeCommandAuthorizationPolicy,
} from "../../packages/gittensory-engine/src/settings/command-authorization";

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

  it("gate-override is maintainer/collaborator only and ignores spoofable author_association", () => {
    // The gateOverridePolicy ships maintainer+collaborator only (no pr_author / confirmed_miner).
    expect(commandAuthorizationAllowedRoles(undefined, "gate-override")).toEqual(["maintainer", "collaborator"]);
    // Real admin/maintain → MEMBER and real write → COLLABORATOR are the only associations that pass.
    expect(evaluateCommandAuthorization({ commandName: "gate-override", commenterAssociation: "MEMBER" })).toMatchObject({ authorized: true, reason: "maintainer_invocation", actorKind: "maintainer" });
    expect(evaluateCommandAuthorization({ commandName: "gate-override", commenterAssociation: "COLLABORATOR" })).toMatchObject({ authorized: true, reason: "collaborator_invocation", actorKind: "maintainer" });
    // An org member WITHOUT real repo write resolves (in the handler) to a null association → denied here,
    // even if the PR author tries it themselves.
    expect(evaluateCommandAuthorization({ commandName: "gate-override", commenterAssociation: null })).toMatchObject({ authorized: false });
    expect(evaluateCommandAuthorization({ commandName: "gate-override", commenterLogin: "author", pullRequestAuthorLogin: "author", commenterAssociation: null })).toMatchObject({ authorized: false });
  });

  it("matches command keys case-insensitively so a mixed-case name cannot dodge the maintainer-only restriction", () => {
    // Policy keys are stored lowercased; a raw mixed-case/whitespace probe must normalize to the same key,
    // otherwise it falls through to the permissive default and skips the maintainer-only guard.
    expect(commandAuthorizationAllowedRoles(undefined, "Gate-Override")).toEqual(["maintainer", "collaborator"]);
    expect(commandAuthorizationAllowedRoles(undefined, "  QUEUE-SUMMARY  ")).toEqual(["maintainer", "collaborator"]);
    // A PR author invoking the maintainer-only command under a different casing is still denied (not granted
    // the permissive default), and the miner lookup is still required where confirmed_miner is allowed.
    expect(
      evaluateCommandAuthorization({ commandName: "Gate-Override", commenterLogin: "author", pullRequestAuthorLogin: "author", commenterAssociation: null }),
    ).toMatchObject({ authorized: false, reason: "maintainer_command_requires_maintainer", actorKind: "author" });
    expect(
      commandAuthorizationNeedsMinerDetection({ commandName: "REVIEW-NOW", commenterLogin: "miner", pullRequestAuthorLogin: "miner" }),
    ).toBe(false);
  });

  it("clamps the spoofable pr_author role off maintainer-only commands but keeps confirmed_miner (#824)", () => {
    const { policy, warnings } = normalizeCommandAuthorizationPolicy({
      commands: {
        "review-now": ["confirmed_miner"],
        "queue-summary": ["collaborator", "pr_author"],
        "needs-author": ["pr_author"],
      },
    });

    // confirmed_miner is exempt from the maintainer-only clamp, so it survives without a warning.
    expect(warnings).not.toContain("Ignored author command authorization roles for maintainer-only command: review-now.");
    expect(warnings).toContain("Ignored author command authorization roles for maintainer-only command: queue-summary.");
    expect(warnings).toContain("Ignored author command authorization roles for maintainer-only command: needs-author.");
    expect(policy.commands["review-now"]).toEqual(["confirmed_miner"]);
    expect(policy.commands["queue-summary"]).toEqual(["collaborator"]);
    // Dropping the only role (plain pr_author) falls back to the secure maintainer/collaborator default.
    expect(policy.commands["needs-author"]).toEqual(["maintainer", "collaborator"]);
    expect(commandAuthorizationAllowedRoles(policy, "review-now")).toEqual(["confirmed_miner"]);
    // A confirmed-miner PR author can self-trigger a maintainer-only command when the policy allows it.
    expect(
      evaluateCommandAuthorization({
        policy: { commands: { "review-now": ["confirmed_miner"] }, default: ["confirmed_miner"] },
        commandName: "review-now",
        commenterLogin: "miner",
        pullRequestAuthorLogin: "miner",
        minerStatus: "confirmed",
      }),
    ).toMatchObject({
      authorized: true,
      reason: "confirmed_miner_pr_author",
      actorKind: "author",
      allowedRoles: ["confirmed_miner"],
    });
    // A plain PR author (not a confirmed miner) is still denied on the same maintainer-only command.
    expect(
      evaluateCommandAuthorization({
        policy: { commands: { "review-now": ["confirmed_miner"] }, default: ["confirmed_miner"] },
        commandName: "review-now",
        commenterLogin: "author",
        pullRequestAuthorLogin: "author",
        minerStatus: "not_found",
      }),
    ).toMatchObject({
      authorized: false,
      reason: "pr_author_not_confirmed_miner",
      allowedRoles: ["confirmed_miner"],
    });
  });

  it("requires miner detection when a PR author self-invokes a confirmed_miner command with no other qualifying role", () => {
    // "review" allows confirmed_miner; a self-invoking author with no maintainer/collaborator role
    // forces a miner lookup to decide authorization.
    expect(
      commandAuthorizationNeedsMinerDetection({ commandName: "review", commenterLogin: "author", pullRequestAuthorLogin: "author" }),
    ).toBe(true);
    // A different commenter than the PR author never needs miner detection (not a self-invocation).
    expect(
      commandAuthorizationNeedsMinerDetection({ commandName: "review", commenterLogin: "someone-else", pullRequestAuthorLogin: "author" }),
    ).toBe(false);
  });

  it("reports miner_detection_unavailable when a self-invoking author lacks a resolvable miner status", () => {
    expect(
      evaluateCommandAuthorization({ commandName: "review", commenterLogin: "author", pullRequestAuthorLogin: "author" }),
    ).toMatchObject({ authorized: false, reason: "miner_detection_unavailable", actorKind: "author" });
    expect(
      evaluateCommandAuthorization({ commandName: "review", commenterLogin: "author", pullRequestAuthorLogin: "author", minerStatus: "unavailable" }),
    ).toMatchObject({ authorized: false, reason: "miner_detection_unavailable" });
  });

  it("falls back to the built-in default roles when a maintainer-only default command is given only author roles", () => {
    // queue-summary is a maintainer-only default command; stripping its lone pr_author role restores
    // the built-in default (not the generic maintainer/collaborator literal fallback).
    const { policy } = normalizeCommandAuthorizationPolicy({ commands: { "queue-summary": ["pr_author"] } });
    expect(policy.commands["queue-summary"]).toEqual(["maintainer", "collaborator"]);
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

  it("defaults the #1960 PR control-surface verbs to maintainer/collaborator-only, except review (widenable to confirmed_miner)", () => {
    expect(commandAuthorizationAllowedRoles(undefined, "review")).toEqual(["maintainer", "collaborator", "confirmed_miner"]);
    for (const command of ["pause", "resume", "resolve", "configuration", "explain"]) {
      expect(commandAuthorizationAllowedRoles(undefined, command)).toEqual(["maintainer", "collaborator"]);
    }
    // A confirmed-miner PR author can self-trigger "review" (the #824 self-rerun precedent), but not "pause".
    expect(
      evaluateCommandAuthorization({ commandName: "review", commenterLogin: "miner", pullRequestAuthorLogin: "miner", minerStatus: "confirmed" }),
    ).toMatchObject({ authorized: true, reason: "confirmed_miner_pr_author", actorKind: "author" });
    expect(
      evaluateCommandAuthorization({ commandName: "pause", commenterLogin: "miner", pullRequestAuthorLogin: "miner", minerStatus: "confirmed" }),
    ).toMatchObject({ authorized: false, reason: "maintainer_command_requires_maintainer" });
    // Maintainers and collaborators are authorized on every new verb.
    for (const command of ["review", "pause", "resume", "resolve", "configuration", "explain"]) {
      expect(evaluateCommandAuthorization({ commandName: command, commenterAssociation: "OWNER" })).toMatchObject({ authorized: true, reason: "maintainer_invocation" });
      expect(evaluateCommandAuthorization({ commandName: command, commenterAssociation: "COLLABORATOR" })).toMatchObject({ authorized: true, reason: "collaborator_invocation" });
    }
    // A spoofable pr_author role added to one of the maintainer-only new verbs is clamped off with a warning;
    // the confirmed_miner role on "review" is not spoofable via author_association and survives untouched.
    const clamped = normalizeCommandAuthorizationPolicy({ commands: { resolve: ["collaborator", "pr_author"], review: ["confirmed_miner"] } });
    expect(clamped.warnings).toContain("Ignored author command authorization roles for maintainer-only command: resolve.");
    expect(clamped.warnings).not.toContain("Ignored author command authorization roles for maintainer-only command: review.");
    expect(clamped.policy.commands.resolve).toEqual(["collaborator"]);
    expect(clamped.policy.commands.review).toEqual(["confirmed_miner"]);
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
