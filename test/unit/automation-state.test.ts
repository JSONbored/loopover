import { beforeEach, describe, expect, it, vi } from "vitest";

// buildAutomationState folds three DB/settings reads into the derived automation-state view (#6742). We stub
// only those IO edges (getRepository / getInstallation / countPendingAgentActions / isGlobalAgentFrozen /
// resolveRepositorySettings) so the REAL fold logic -- resolveAgentActionMode, resolveAgentPermissionReadiness,
// the acting-class filter, and the missing-repo/installation branches -- is exercised directly, not through the
// REST/MCP/CLI happy-path tests that are its only incidental coverage today.
vi.mock("../../src/db/repositories", () => ({
  getRepository: vi.fn(),
  getInstallation: vi.fn(),
  countPendingAgentActions: vi.fn(),
  isGlobalAgentFrozen: vi.fn(),
}));

vi.mock("../../src/settings/repository-settings", () => ({
  resolveRepositorySettings: vi.fn(),
}));

import { countPendingAgentActions, getInstallation, getRepository, isGlobalAgentFrozen } from "../../src/db/repositories";
import { automationStateSummary, buildAutomationState, type AutomationState } from "../../src/services/automation-state";
import { resolveRepositorySettings } from "../../src/settings/repository-settings";
import type { InstallationRecord, RepositoryRecord, RepositorySettings } from "../../src/types";

const REPO = "acme/widgets";

function makeSettings(overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  // buildAutomationState reads only these four fields; the rest of the (large) settings row is irrelevant here.
  return { repoFullName: REPO, autonomy: {}, autoMaintain: { requireApprovals: 1, mergeMethod: "squash" }, agentPaused: false, agentDryRun: false, ...overrides } as unknown as RepositorySettings;
}

function makeRepo(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return { fullName: REPO, owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false, ...overrides };
}

function makeInstallation(permissions: Record<string, string>): InstallationRecord {
  return { id: 42, accountLogin: "acme", accountId: 7, targetType: "Organization", permissions, events: [] };
}

function envWith(pausedFlag = ""): Env {
  return { AGENT_ACTIONS_PAUSED: pausedFlag } as unknown as Env;
}

const mockGetRepository = vi.mocked(getRepository);
const mockGetInstallation = vi.mocked(getInstallation);
const mockCountPending = vi.mocked(countPendingAgentActions);
const mockFrozen = vi.mocked(isGlobalAgentFrozen);
const mockSettings = vi.mocked(resolveRepositorySettings);

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults each test overrides only what it exercises.
  mockGetRepository.mockResolvedValue(makeRepo({ installationId: 42 }));
  mockGetInstallation.mockResolvedValue(makeInstallation({ pull_requests: "write", contents: "write" }));
  mockCountPending.mockResolvedValue(0);
  mockFrozen.mockResolvedValue(false);
  mockSettings.mockResolvedValue(makeSettings());
});

describe("buildAutomationState", () => {
  it("derives a live, ready, configured view for an installed repo with a mix of acting and non-acting classes", async () => {
    // review/merge act (auto), close is deny-by-default observe -> only the acting classes survive the filter.
    mockSettings.mockResolvedValue(makeSettings({ autonomy: { review: "auto", merge: "auto", close: "observe" } }));
    mockCountPending.mockResolvedValue(3);

    const state = await buildAutomationState(envWith(), REPO);

    expect(state).toMatchObject({
      repoFullName: REPO,
      configured: true,
      mode: "live",
      permissionReadiness: "ready",
      agentPaused: false,
      agentDryRun: false,
      pendingActionCount: 3,
    });
    expect(state.actingActionClasses).toEqual(["review", "merge"]);
    expect(state.actingActionClasses).not.toContain("close");
    expect(mockGetInstallation).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("locks the configured = actingActionClasses.length > 0 contract to false when no class acts", async () => {
    mockSettings.mockResolvedValue(makeSettings({ autonomy: {} }));

    const state = await buildAutomationState(envWith(), REPO);

    expect(state.actingActionClasses).toEqual([]);
    expect(state.configured).toBe(false);
    // No acting class needs a write scope, so readiness collapses to not_required regardless of installation.
    expect(state.permissionReadiness).toBe("not_required");
  });

  it("treats a missing repo (getRepository null) as no installation without throwing", async () => {
    mockGetRepository.mockResolvedValue(null);
    mockSettings.mockResolvedValue(makeSettings({ autonomy: { review: "auto" } }));

    const state = await buildAutomationState(envWith(), REPO);

    expect(mockGetInstallation).not.toHaveBeenCalled();
    // review acts -> pull_requests:write required, but with no installation permissions readiness must re-consent.
    expect(state.permissionReadiness).toBe("reconsent_required");
    expect(state.configured).toBe(true);
  });

  it("skips the installation lookup when the repo row carries no installationId", async () => {
    mockGetRepository.mockResolvedValue(makeRepo({ installationId: null }));
    mockSettings.mockResolvedValue(makeSettings({ autonomy: { merge: "auto" } }));

    const state = await buildAutomationState(envWith(), REPO);

    expect(mockGetInstallation).not.toHaveBeenCalled();
    // merge acts -> contents:write required, none granted -> re-consent.
    expect(state.permissionReadiness).toBe("reconsent_required");
  });

  it("derives null installation permissions when the installation row is missing despite an id", async () => {
    mockGetInstallation.mockResolvedValue(null);
    mockSettings.mockResolvedValue(makeSettings({ autonomy: { review: "auto" } }));

    const state = await buildAutomationState(envWith(), REPO);

    expect(mockGetInstallation).toHaveBeenCalledWith(expect.anything(), 42);
    expect(state.permissionReadiness).toBe("reconsent_required");
  });

  it("resolves paused from the global env pause without consulting the DB freeze flag", async () => {
    // Repo-level flags are both false; the global env kill-switch alone must force paused, and short-circuit the
    // `||` so isGlobalAgentFrozen is never read.
    mockSettings.mockResolvedValue(makeSettings({ agentPaused: false, agentDryRun: false }));

    const state = await buildAutomationState(envWith("true"), REPO);

    expect(state.mode).toBe("paused");
    expect(mockFrozen).not.toHaveBeenCalled();
  });

  it("resolves paused from the DB global freeze when the env pause is off", async () => {
    mockFrozen.mockResolvedValue(true);
    mockSettings.mockResolvedValue(makeSettings({ agentPaused: false, agentDryRun: false }));

    const state = await buildAutomationState(envWith(""), REPO);

    expect(mockFrozen).toHaveBeenCalledTimes(1);
    expect(state.mode).toBe("paused");
  });

  it("resolves dry_run from the repo-level dry-run flag when nothing global is engaged", async () => {
    mockSettings.mockResolvedValue(makeSettings({ agentPaused: false, agentDryRun: true }));

    const state = await buildAutomationState(envWith(), REPO);

    expect(state.mode).toBe("dry_run");
    expect(state.agentDryRun).toBe(true);
    expect(state.agentPaused).toBe(false);
  });

  it("resolves paused from the repo-level pause flag over dry-run", async () => {
    mockSettings.mockResolvedValue(makeSettings({ agentPaused: true, agentDryRun: true }));

    const state = await buildAutomationState(envWith(), REPO);

    expect(state.mode).toBe("paused");
    expect(state.agentPaused).toBe(true);
    expect(state.agentDryRun).toBe(true);
  });
});

describe("automationStateSummary", () => {
  it("formats the one-line human summary from a representative state", () => {
    const state: AutomationState = {
      repoFullName: "acme/widgets",
      configured: true,
      autonomy: { review: "auto", merge: "auto" },
      autoMaintain: { requireApprovals: 1, mergeMethod: "squash" },
      agentPaused: false,
      agentDryRun: false,
      mode: "live",
      permissionReadiness: "ready",
      actingActionClasses: ["review", "merge"],
      pendingActionCount: 2,
    };

    expect(automationStateSummary(state)).toBe("Agent automation for acme/widgets: mode=live, 2 acting class(es), 2 pending approval(s).");
  });
});
