import { describe, expect, it } from "vitest";
import {
  agentActionModeExecutes,
  agentRequiresContentsWrite,
  agentRequiresPrWrite,
  buildAgentActionAudit,
  STRUCTURED_CLOSE_REASONS_MAX_COUNT,
  formatAgentPermissionDenial,
  isGlobalAgentPause,
  requiredAgentActionPermissions,
  resolveAgentActionMode,
  resolveAgentPermissionReadiness,
} from "../../src/settings/agent-execution";
import { PR_WRITE_CLASSES } from "../../src/services/agent-action-executor";

describe("resolveAgentActionMode (#776 safety gate)", () => {
  it("a global OR per-repo pause halts everything (safest wins)", () => {
    expect(resolveAgentActionMode({ globalPaused: true })).toBe("paused");
    expect(resolveAgentActionMode({ globalPaused: true, agentDryRun: true })).toBe("paused"); // pause beats dry-run
    expect(resolveAgentActionMode({ globalPaused: false, agentPaused: true })).toBe("paused");
    expect(resolveAgentActionMode({ globalPaused: false, agentPaused: true, agentDryRun: true })).toBe("paused");
  });

  it("dry-run wins over live when not paused", () => {
    expect(resolveAgentActionMode({ globalPaused: false, agentDryRun: true })).toBe("dry_run");
    expect(resolveAgentActionMode({ globalPaused: false, agentPaused: false, agentDryRun: true })).toBe("dry_run");
  });

  it("defaults to live only when nothing is set", () => {
    expect(resolveAgentActionMode({ globalPaused: false })).toBe("live");
    expect(resolveAgentActionMode({ globalPaused: false, agentPaused: false, agentDryRun: false })).toBe("live");
    expect(resolveAgentActionMode({ globalPaused: false, agentPaused: null, agentDryRun: null })).toBe("live");
  });

  it("only live actually executes", () => {
    expect(agentActionModeExecutes("live")).toBe(true);
    expect(agentActionModeExecutes("dry_run")).toBe(false);
    expect(agentActionModeExecutes("paused")).toBe(false);
  });
});

describe("isGlobalAgentPause", () => {
  it("recognizes the truthy-string forms and treats everything else as not paused", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(isGlobalAgentPause({ AGENT_ACTIONS_PAUSED: v })).toBe(true);
    for (const v of ["0", "false", "no", "off", "", "maybe"]) expect(isGlobalAgentPause({ AGENT_ACTIONS_PAUSED: v })).toBe(false);
    expect(isGlobalAgentPause({})).toBe(false);
  });
});

describe("buildAgentActionAudit", () => {
  it("produces a structured who/what/why/outcome/mode audit record", () => {
    const audit = buildAgentActionAudit({
      actionClass: "merge",
      autonomyLevel: "auto_with_approval",
      mode: "dry_run",
      outcome: "completed",
      repoFullName: "owner/repo",
      targetKey: "owner/repo#7",
      actor: "gittensory",
      reason: "merge-readiness met",
    });
    expect(audit).toMatchObject({
      eventType: "agent.action.merge",
      actor: "gittensory",
      targetKey: "owner/repo#7",
      outcome: "completed",
      detail: "merge-readiness met",
      metadata: { repoFullName: "owner/repo", actionClass: "merge", autonomyLevel: "auto_with_approval", mode: "dry_run" },
    });
  });

  it("falls back to the repo as the target key and null actor/reason", () => {
    const audit = buildAgentActionAudit({ actionClass: "label", autonomyLevel: "auto", mode: "live", outcome: "completed", repoFullName: "owner/repo" });
    expect(audit.targetKey).toBe("owner/repo");
    expect(audit.actor).toBeNull();
    expect(audit.detail).toBeNull();
  });

  it("records structured close reasons only for close-action audit metadata", () => {
    const closeAudit = buildAgentActionAudit({
      actionClass: "close",
      autonomyLevel: "auto",
      mode: "live",
      outcome: "completed",
      repoFullName: "owner/repo",
      reason: "ci failed; blocker",
      closeReasons: ["ci failed", "blocker"],
    });
    expect(closeAudit.metadata).toMatchObject({ closeReasons: ["ci failed", "blocker"], closeReasonCount: 2 });

    const mergeAudit = buildAgentActionAudit({
      actionClass: "merge",
      autonomyLevel: "auto",
      mode: "live",
      outcome: "completed",
      repoFullName: "owner/repo",
      reason: "clean",
      closeReasons: ["must not attach"],
    });
    expect(mergeAudit.metadata).not.toHaveProperty("closeReasons");
    expect(mergeAudit.metadata).not.toHaveProperty("closeReasonCount");

    const legacyCloseAudit = buildAgentActionAudit({
      actionClass: "close",
      autonomyLevel: "auto",
      mode: "live",
      outcome: "completed",
      repoFullName: "owner/repo",
      reason: "legacy flattened reason",
    });
    expect(legacyCloseAudit.metadata).not.toHaveProperty("closeReasons");

    const emptyCloseAudit = buildAgentActionAudit({
      actionClass: "close",
      autonomyLevel: "auto",
      mode: "live",
      outcome: "completed",
      repoFullName: "owner/repo",
      reason: "empty reason list",
      closeReasons: [],
    });
    expect(emptyCloseAudit.metadata).not.toHaveProperty("closeReasons");

    const manyCloseReasons = Array.from({ length: STRUCTURED_CLOSE_REASONS_MAX_COUNT + 1 }, (_, index) => `blocker ${index}`);
    const truncatedCloseAudit = buildAgentActionAudit({
      actionClass: "close",
      autonomyLevel: "auto",
      mode: "live",
      outcome: "completed",
      repoFullName: "owner/repo",
      reason: "many blockers",
      closeReasons: manyCloseReasons,
    });
    expect(truncatedCloseAudit.metadata).toMatchObject({
      closeReasons: manyCloseReasons.slice(0, STRUCTURED_CLOSE_REASONS_MAX_COUNT),
      closeReasonCount: manyCloseReasons.length,
      closeReasonsTruncated: true,
    });
  });
});

describe("agent write-permission readiness (#775)", () => {
  it("agentRequiresPrWrite is true only for an acting level on a PR-write action class", () => {
    expect(agentRequiresPrWrite({ merge: "auto" })).toBe(false);
    expect(agentRequiresContentsWrite({ merge: "auto" })).toBe(true);
    expect(agentRequiresPrWrite({ request_changes: "auto_with_approval" })).toBe(true);
    expect(agentRequiresPrWrite({ close: "auto" })).toBe(true);
    // non-acting levels never demand write
    expect(agentRequiresPrWrite({ merge: "propose", review: "suggest" })).toBe(false);
    expect(agentRequiresPrWrite({ merge: "observe" })).toBe(false);
    expect(agentRequiresPrWrite({})).toBe(false);
    expect(agentRequiresPrWrite(null)).toBe(false);
    // update_branch (PUT /pulls/{n}/update-branch) is a PR-write the executor gates → it demands write too (#audit-update-branch)
    expect(agentRequiresPrWrite({ update_branch: "auto" })).toBe(true);
    expect(agentRequiresPrWrite({ update_branch: "auto_with_approval" })).toBe(true);
    expect(agentRequiresPrWrite({ update_branch: "observe" })).toBe(false); // non-acting still no write
    // label acts via the Issues API (issues: write, already held), so it does NOT demand pull_requests: write
    expect(agentRequiresPrWrite({ label: "auto" })).toBe(false);
    expect(agentRequiresContentsWrite({ merge: "observe" })).toBe(false);
    expect(agentRequiresContentsWrite({})).toBe(false);
    expect(agentRequiresContentsWrite(null)).toBe(false);
  });

  it("INVARIANT: every executor write class has an action-specific permission requirement", () => {
    // The executor denies a write action whose readiness !== "ready". If a class it gates were missing from
    // requiredAgentActionPermissions, the readiness guard would grade it "not_required" and the gate would diverge.
    for (const actionClass of PR_WRITE_CLASSES) {
      expect(requiredAgentActionPermissions({ [actionClass]: "auto" }, actionClass).length).toBeGreaterThan(0);
    }
  });

  it("REGRESSION (#audit-update-branch): an update_branch-only acting autonomy resolves readiness instead of 'not_required'", () => {
    // Before the fix update_branch was absent from PR_WRITE_ACTION_CLASSES, so this graded "not_required" and the
    // executor's `!== "ready"` guard denied update_branch even WITH write granted (and would 403 if it slipped).
    expect(resolveAgentPermissionReadiness({ autonomy: { update_branch: "auto" }, installationPermissions: { pull_requests: "write" } })).toBe("ready");
    expect(resolveAgentPermissionReadiness({ autonomy: { update_branch: "auto" }, installationPermissions: { pull_requests: "read" } })).toBe("reconsent_required");
  });

  it("resolveAgentPermissionReadiness gates on the exact granted scopes for each acting action", () => {
    // no acting PR-write level → permission is irrelevant
    expect(resolveAgentPermissionReadiness({ autonomy: { label: "auto" }, installationPermissions: { pull_requests: "read" } })).toBe("not_required");
    // merge is authorized by Contents: write, not Pull requests: write.
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: { contents: "write", pull_requests: "read" } })).toBe("ready");
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: { pull_requests: "write" } })).toBe("reconsent_required");
    // non-merge PR state mutations still require Pull requests: write.
    expect(resolveAgentPermissionReadiness({ autonomy: { approve: "auto" }, installationPermissions: { contents: "write", pull_requests: "read" } })).toBe("reconsent_required");
    expect(resolveAgentPermissionReadiness({ autonomy: { approve: "auto" }, installationPermissions: { pull_requests: "write" } })).toBe("ready");
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: {} })).toBe("reconsent_required");
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: null })).toBe("reconsent_required");
  });

  it("formats the missing action permission instead of blaming pull_requests for merge", () => {
    expect(formatAgentPermissionDenial({ autonomy: { merge: "auto" }, installationPermissions: { pull_requests: "write" }, actionClass: "merge" })).toBe(
      "contents: write not granted — maintainer must re-consent",
    );
    expect(formatAgentPermissionDenial({ autonomy: { close: "auto" }, installationPermissions: { contents: "write" }, actionClass: "close", suppressed: true })).toBe(
      "pull_requests: write not granted — maintainer must re-consent (suppressed repeat)",
    );
  });
});
