// Mirror of the app suite pointed at the loopover-engine copy so the extracted module owns its branch coverage (#2280).
import { describe, expect, it } from "vitest";
import {
  commandAuthorizationAllowedRoles,
  commandAuthorizationNeedsMinerDetection,
  DEFAULT_COMMAND_AUTHORIZATION_POLICY,
  evaluateCommandAuthorization,
  normalizeCommandAuthorizationPolicy,
  summarizeCommandAuthorizationPolicy,
} from "../../packages/loopover-engine/src/settings/command-authorization";

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

  it("#4595/#5084: chat defaults to maintainer/collaborator/pr_author (unlike ask's default, no confirmed_miner)", () => {
    expect(commandAuthorizationAllowedRoles(undefined, "chat")).toEqual(["maintainer", "collaborator", "pr_author"]);
    expect(evaluateCommandAuthorization({ commandName: "chat", commenterAssociation: "OWNER" })).toMatchObject({ authorized: true, reason: "maintainer_invocation", actorKind: "maintainer" });
    expect(evaluateCommandAuthorization({ commandName: "chat", commenterAssociation: "COLLABORATOR" })).toMatchObject({ authorized: true, reason: "collaborator_invocation", actorKind: "maintainer" });
  });

  it("#5084: a chat pr_author match is only granted when commandRateLimitPolicy is \"hold\" for the repo", () => {
    // No rate-limit policy passed at all (the undefined branch) -- denied, with a distinct reason from the
    // generic denials so an operator can tell "rate limiting isn't on" apart from "not authorized at all".
    // pullRequestOpenAndNotDraft: true throughout, so this test isolates the rate-limit gate specifically.
    expect(
      evaluateCommandAuthorization({ commandName: "chat", commenterLogin: "author", pullRequestAuthorLogin: "author", pullRequestOpenAndNotDraft: true }),
    ).toMatchObject({ authorized: false, reason: "pr_author_requires_rate_limiting", actorKind: "author", matchedRole: null });
    // Explicitly "off" (not just unset) -- same denial, covering both falsy branches of the `!== "hold"` check.
    expect(
      evaluateCommandAuthorization({ commandName: "chat", commenterLogin: "author", pullRequestAuthorLogin: "author", commandRateLimitPolicy: "off", pullRequestOpenAndNotDraft: true }),
    ).toMatchObject({ authorized: false, reason: "pr_author_requires_rate_limiting" });
    // "hold" -- the PR's own author is authorized.
    expect(
      evaluateCommandAuthorization({ commandName: "chat", commenterLogin: "author", pullRequestAuthorLogin: "author", commandRateLimitPolicy: "hold", pullRequestOpenAndNotDraft: true }),
    ).toMatchObject({ authorized: true, reason: "allowed_pr_author", actorKind: "author", matchedRole: "pr_author" });
    // A confirmed miner acting on their OWN PR matches pr_author first (chat's roles list has pr_author, not
    // confirmed_miner) -- so a miner is gated by the SAME rate-limit requirement as any other PR author, not
    // the separate confirmed_miner exception "review" gets.
    expect(
      evaluateCommandAuthorization({ commandName: "chat", commenterLogin: "miner", pullRequestAuthorLogin: "miner", minerStatus: "confirmed", pullRequestOpenAndNotDraft: true }),
    ).toMatchObject({ authorized: false, reason: "pr_author_requires_rate_limiting" });
    expect(
      evaluateCommandAuthorization({ commandName: "chat", commenterLogin: "miner", pullRequestAuthorLogin: "miner", minerStatus: "confirmed", commandRateLimitPolicy: "hold", pullRequestOpenAndNotDraft: true }),
    ).toMatchObject({ authorized: true, reason: "allowed_pr_author", matchedRole: "pr_author" });
    // A commenter on someone ELSE's PR is still denied outright -- pr_author never matches for a non-author,
    // rate limiting or not.
    expect(
      evaluateCommandAuthorization({ commandName: "chat", commenterLogin: "other", pullRequestAuthorLogin: "author", commandRateLimitPolicy: "hold", pullRequestOpenAndNotDraft: true }),
    ).toMatchObject({ authorized: false, reason: "not_maintainer_or_pr_author" });
  });

  it("#5092: a chat pr_author match is ALSO only granted when the PR is open and not draft", () => {
    // commandRateLimitPolicy: "hold" throughout, so this test isolates the PR-state gate specifically. The
    // per-PR rate-limit counter (repoFullName#issueNumber#command) never checks PR state on its own, so
    // without this a contributor could keep a fresh chat allowance forever by reopening/reusing a closed PR
    // or spamming cheap draft PRs.
    const base = { commandName: "chat", commenterLogin: "author", pullRequestAuthorLogin: "author", commandRateLimitPolicy: "hold" as const };
    // Unset (the undefined branch) -- denied, distinct reason from the rate-limit denial.
    expect(evaluateCommandAuthorization(base)).toMatchObject({ authorized: false, reason: "pr_author_requires_open_pr", actorKind: "author", matchedRole: null });
    // Explicitly false (not just unset) -- same denial, covering both falsy branches of the `!== true` check.
    expect(evaluateCommandAuthorization({ ...base, pullRequestOpenAndNotDraft: false })).toMatchObject({ authorized: false, reason: "pr_author_requires_open_pr" });
    // Open and not draft -- authorized.
    expect(evaluateCommandAuthorization({ ...base, pullRequestOpenAndNotDraft: true })).toMatchObject({ authorized: true, reason: "allowed_pr_author", matchedRole: "pr_author" });
    // Maintainers/collaborators are completely unaffected by PR state -- the check only bounds the
    // less-trusted pr_author tier, never already-trusted roles.
    expect(evaluateCommandAuthorization({ commandName: "chat", commenterAssociation: "OWNER" })).toMatchObject({ authorized: true, reason: "maintainer_invocation" });
    expect(evaluateCommandAuthorization({ commandName: "chat", commenterAssociation: "COLLABORATOR" })).toMatchObject({ authorized: true, reason: "collaborator_invocation" });
  });

  it("#5084: a maintainer's yml override restating chat's own default (incl. pr_author) is not clamped away", () => {
    const restated = normalizeCommandAuthorizationPolicy({ commands: { chat: ["collaborator", "pr_author"] } });
    expect(restated.warnings).not.toContain("Ignored author command authorization roles for maintainer-only command: chat.");
    expect(restated.policy.commands.chat).toEqual(["collaborator", "pr_author"]);
    // But every OTHER maintainer-only command's own shipped default still excludes pr_author, so the SAME
    // override shape on a different command is still clamped -- this is a per-command union, not a blanket
    // relaxation of the clamp.
    const otherCommand = normalizeCommandAuthorizationPolicy({ commands: { "queue-summary": ["collaborator", "pr_author"] } });
    expect(otherCommand.warnings).toContain("Ignored author command authorization roles for maintainer-only command: queue-summary.");
    expect(otherCommand.policy.commands["queue-summary"]).toEqual(["collaborator"]);
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

  it("#9998: returns fresh, non-aliased role arrays on every input and freezes the default", () => {
    // The record path used a shallow spread, sharing every un-overridden command's array with the module-level
    // default; a caller mutating a returned array would corrupt the vocabulary for every repo in the isolate.
    for (const input of [{}, null, { commands: { plan: ["maintainer"] } }] as const) {
      const policy = normalizeCommandAuthorizationPolicy(input).policy;
      // `pause` is never overridden by any of these inputs, so it exercises the deep-copied default path.
      expect(policy.commands["pause"]).not.toBe(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["pause"]);
      expect(policy.commands["pause"]).toEqual(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["pause"]);
    }
    const review = normalizeCommandAuthorizationPolicy({}).policy.commands["review"];
    expect(review).toBeDefined();
    review?.push("pr_author");
    expect(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["review"]).toEqual(["maintainer", "collaborator", "confirmed_miner"]);
    expect(Object.isFrozen(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["generate-tests"])).toBe(true);
    expect(Object.isFrozen(DEFAULT_COMMAND_AUTHORIZATION_POLICY)).toBe(true);
  });
});
