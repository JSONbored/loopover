import { describe, expect, it } from "vitest";
import {
  agentActionModeExecutes,
  agentRequiresPrWrite,
  buildAgentActionAudit,
  isGlobalAgentPause,
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
});

describe("agent write-permission readiness (#775)", () => {
  it("agentRequiresPrWrite is true only for an acting level on a PR-write action class", () => {
    expect(agentRequiresPrWrite({ merge: "auto" })).toBe(true);
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
  });

  it("INVARIANT: every executor PR_WRITE_CLASS is counted by agentRequiresPrWrite (the readiness gate cannot disagree with the runtime guard)", () => {
    // The executor denies a PR-write action whose readiness !== "ready". If a class it gates were missing from
    // PR_WRITE_ACTION_CLASSES, agentRequiresPrWrite would grade it "not_required" and the gate would diverge — the
    // exact #audit-update-branch bug. Enforce executor PR_WRITE_CLASSES ⊆ readiness write-classes for ALL members.
    for (const actionClass of PR_WRITE_CLASSES) {
      expect(agentRequiresPrWrite({ [actionClass]: "auto" })).toBe(true);
    }
  });

  it("REGRESSION (#audit-update-branch): an update_branch-only acting autonomy resolves readiness instead of 'not_required'", () => {
    // Before the fix update_branch was absent from PR_WRITE_ACTION_CLASSES, so this graded "not_required" and the
    // executor's `!== "ready"` guard denied update_branch even WITH write granted (and would 403 if it slipped).
    expect(resolveAgentPermissionReadiness({ autonomy: { update_branch: "auto" }, installationPermissions: { pull_requests: "write" } })).toBe("ready");
    expect(resolveAgentPermissionReadiness({ autonomy: { update_branch: "auto" }, installationPermissions: { pull_requests: "read" } })).toBe("reconsent_required");
  });

  it("resolveAgentPermissionReadiness gates on the granted pull_requests scope", () => {
    // no acting PR-write level → permission is irrelevant
    expect(resolveAgentPermissionReadiness({ autonomy: { label: "auto" }, installationPermissions: { pull_requests: "read" } })).toBe("not_required");
    // acting level + write granted → ready
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: { pull_requests: "write", issues: "write" } })).toBe("ready");
    // acting level but only read (or missing) → re-consent required
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: { pull_requests: "read" } })).toBe("reconsent_required");
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: {} })).toBe("reconsent_required");
    expect(resolveAgentPermissionReadiness({ autonomy: { merge: "auto" }, installationPermissions: null })).toBe("reconsent_required");
  });
});
