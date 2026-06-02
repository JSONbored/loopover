import { isAuthorizedGitHubSessionLogin } from "../auth/security";
import { getFreshOfficialMinerDetection, listAllPullRequests, listInstallations, listRepositories } from "../db/repositories";
import type { ControlPanelRoleCard, ControlPanelRoleName, ControlPanelRoleSummary, InstallationRecord, PullRequestRecord, RepositoryRecord } from "../types";
import { nowIso } from "../utils/json";

export type RoleSummaryInputs = {
  login: string;
  generatedAt: string;
  confirmedMiner: boolean;
  operator: boolean;
  repositories: RepositoryRecord[];
  installations: InstallationRecord[];
  pullRequests: PullRequestRecord[];
};

export type ControlPanelAccessScope = {
  operator: boolean;
  repositoryFullNames: string[];
  installationIds: number[];
  accountLogins: string[];
};

export async function loadControlPanelAccessScope(env: Env, login: string): Promise<ControlPanelAccessScope> {
  const [repositories, installations, pullRequests] = await Promise.all([listRepositories(env), listInstallations(env), listAllPullRequests(env)]);
  return buildControlPanelAccessScope({
    login,
    generatedAt: nowIso(),
    confirmedMiner: false,
    operator: isAuthorizedGitHubSessionLogin(env, login),
    repositories,
    installations,
    pullRequests,
  });
}

export async function loadControlPanelRoleSummary(env: Env, login: string): Promise<ControlPanelRoleSummary> {
  const [miner, repositories, installations, pullRequests] = await Promise.all([
    getFreshOfficialMinerDetection(env, login).catch(() => null),
    listRepositories(env),
    listInstallations(env),
    listAllPullRequests(env),
  ]);
  return buildControlPanelRoleSummary({
    login,
    generatedAt: nowIso(),
    confirmedMiner: miner?.status === "confirmed",
    operator: isAuthorizedGitHubSessionLogin(env, login),
    repositories,
    installations,
    pullRequests,
  });
}

export function buildControlPanelAccessScope(args: RoleSummaryInputs): ControlPanelAccessScope {
  const installedRepos = args.repositories.filter((repo) => repo.isInstalled);
  const accountInstallations = args.installations.filter((installation) => !installation.suspendedAt && sameLogin(installation.accountLogin, args.login));
  const accountInstallationIds = new Set(accountInstallations.map((installation) => installation.id));
  const ownedInstalledRepos = installedRepos.filter((repo) => sameLogin(repo.owner, args.login) || (repo.installationId !== undefined && repo.installationId !== null && accountInstallationIds.has(repo.installationId)));
  const maintainerRepos = uniqueRepoNames(
    args.pullRequests
      .filter((pull) => sameLogin(pull.authorLogin, args.login) && isMaintainerAssociation(pull.authorAssociation))
      .map((pull) => pull.repoFullName)
      .filter((repoFullName) => installedRepos.some((repo) => sameRepo(repo.fullName, repoFullName))),
  );
  const scopedRepoNames = uniqueRepoNames([...ownedInstalledRepos.map((repo) => repo.fullName), ...maintainerRepos]);
  const scopedInstallationIds = new Set(accountInstallations.map((installation) => installation.id));
  for (const repo of installedRepos) {
    if (scopedRepoNames.some((repoFullName) => sameRepo(repo.fullName, repoFullName)) && repo.installationId !== undefined && repo.installationId !== null) {
      scopedInstallationIds.add(repo.installationId);
    }
  }
  const scopedAccountLogins = uniqueLogins(accountInstallations.map((installation) => installation.accountLogin));
  return {
    operator: args.operator,
    repositoryFullNames: scopedRepoNames,
    installationIds: [...scopedInstallationIds],
    accountLogins: scopedAccountLogins,
  };
}

export function buildControlPanelRoleSummary(args: RoleSummaryInputs): ControlPanelRoleSummary {
  const installedRepos = args.repositories.filter((repo) => repo.isInstalled);
  const accountInstallations = args.installations.filter((installation) => !installation.suspendedAt && sameLogin(installation.accountLogin, args.login));
  const accountInstallationIds = new Set(accountInstallations.map((installation) => installation.id));
  const ownedInstalledRepos = installedRepos.filter((repo) => sameLogin(repo.owner, args.login) || (repo.installationId !== undefined && repo.installationId !== null && accountInstallationIds.has(repo.installationId)));
  const maintainerRepos = uniqueRepos(
    args.pullRequests
      .filter((pull) => sameLogin(pull.authorLogin, args.login) && isMaintainerAssociation(pull.authorAssociation))
      .map((pull) => pull.repoFullName)
      .filter((repoFullName) => installedRepos.some((repo) => sameRepo(repo.fullName, repoFullName))),
  );
  const roles: ControlPanelRoleName[] = [];
  if (args.confirmedMiner) roles.push("miner");
  if (maintainerRepos.length > 0 || ownedInstalledRepos.length > 0) roles.push("maintainer");
  if (ownedInstalledRepos.length > 0 || accountInstallations.length > 0) roles.push("owner");
  if (args.operator) roles.push("operator");

  const roleCards = buildRoleCards({
    confirmedMiner: args.confirmedMiner,
    operator: args.operator,
    ownedInstalledRepos: ownedInstalledRepos.map((repo) => repo.fullName),
    maintainerRepos,
    accountInstallations,
  });
  const activeCards = roleCards.filter((card) => card.status === "active");
  return {
    login: args.login,
    generatedAt: args.generatedAt,
    roles,
    confirmedMiner: args.confirmedMiner,
    roleCards,
    onboarding: {
      status: roles.length > 0 ? "ready" : "needs_setup",
      ...(activeCards[0]?.role ? { primaryRole: activeCards[0].role } : {}),
      nextActions:
        roles.length > 0
          ? activeCards.flatMap((card) => card.nextActions).slice(0, 4)
          : [
              "Confirm this GitHub login as a miner before using contributor planning.",
              "Install the GitHub App on a repository you own to unlock maintainer and owner workflows.",
              "Ask an operator to add this login only if you need deployment-level controls.",
            ],
    },
    evidence: {
      ownedInstalledRepos: ownedInstalledRepos.length,
      maintainerRepos: maintainerRepos.length,
      accountInstallations: accountInstallations.length,
      operator: args.operator,
    },
    publicSafe: true,
  };
}

export function buildStaticControlPanelRoleSummary(actor: "api" | "mcp" | "internal"): ControlPanelRoleSummary {
  return {
    login: actor,
    generatedAt: nowIso(),
    roles: ["miner", "maintainer", "owner", "operator"],
    confirmedMiner: false,
    roleCards: [
      roleCard("operator", "active", "Static operator access", "Static service credentials retain deployment-level access.", "/app/operator", 1, [], ["Use a browser session for per-user role routing."]),
    ],
    onboarding: {
      status: "ready",
      primaryRole: "operator",
      nextActions: ["Use a browser session for per-user role routing."],
    },
    evidence: {
      ownedInstalledRepos: 0,
      maintainerRepos: 0,
      accountInstallations: 0,
      operator: true,
    },
    publicSafe: true,
  };
}

function buildRoleCards(args: {
  confirmedMiner: boolean;
  operator: boolean;
  ownedInstalledRepos: string[];
  maintainerRepos: string[];
  accountInstallations: InstallationRecord[];
}): ControlPanelRoleCard[] {
  return [
    roleCard(
      "miner",
      args.confirmedMiner ? "active" : "needs_setup",
      "Miner",
      args.confirmedMiner ? "Confirmed miner identity is available for contributor planning." : "No confirmed miner record is cached for this GitHub login.",
      "/app/miner",
      args.confirmedMiner ? 1 : 0,
      [],
      args.confirmedMiner ? ["Open the miner dashboard for contributor planning."] : ["Confirm this GitHub login as a miner before using contributor planning."],
    ),
    roleCard(
      "maintainer",
      args.maintainerRepos.length > 0 || args.ownedInstalledRepos.length > 0 ? "active" : "needs_setup",
      "Maintainer",
      args.maintainerRepos.length > 0
        ? "Cached PR association shows maintainer access on installed repositories."
        : args.ownedInstalledRepos.length > 0
          ? "Installed repositories owned by this login can use maintainer workflows."
          : "No installed maintainer repository is visible for this login.",
      "/app/maintainer",
      args.maintainerRepos.length + args.ownedInstalledRepos.length,
      uniqueRepos([...args.maintainerRepos, ...args.ownedInstalledRepos]).slice(0, 4),
      args.maintainerRepos.length > 0 || args.ownedInstalledRepos.length > 0 ? ["Review maintainer queue and installation health."] : ["Install the GitHub App on a repository you maintain."],
    ),
    roleCard(
      "owner",
      args.ownedInstalledRepos.length > 0 || args.accountInstallations.length > 0 ? "active" : "needs_setup",
      "Owner",
      args.ownedInstalledRepos.length > 0
        ? "Installed repositories owned by this login are ready for owner workflows."
        : args.accountInstallations.length > 0
          ? "GitHub App account installation is linked to this login."
          : "No owned GitHub App installation is linked to this login.",
      "/app/owner",
      args.ownedInstalledRepos.length + args.accountInstallations.length,
      args.ownedInstalledRepos.slice(0, 4),
      args.ownedInstalledRepos.length > 0 || args.accountInstallations.length > 0 ? ["Open owner readiness for installed repositories."] : ["Install the GitHub App on a repository you own."],
    ),
    roleCard(
      "operator",
      args.operator ? "active" : "needs_setup",
      "Operator",
      args.operator ? "Configured operator login has deployment-level controls." : "This login is not configured for operator controls.",
      "/app/operator",
      args.operator ? 1 : 0,
      [],
      args.operator ? ["Open the operator dashboard."] : ["Ask an operator to add this login only if deployment controls are needed."],
    ),
  ];
}

function roleCard(role: ControlPanelRoleName, status: ControlPanelRoleCard["status"], title: string, detail: string, href: string, evidenceCount: number, sampleRepos: string[], nextActions: string[]): ControlPanelRoleCard {
  return {
    role,
    status,
    title,
    detail: sanitizeRoleText(detail),
    href,
    evidenceCount,
    sampleRepos: sampleRepos.map(sanitizeRoleText),
    nextActions: nextActions.map(sanitizeRoleText),
  };
}

function uniqueRepos(values: string[]): string[] {
  return uniqueRepoNames(values).map(sanitizeRoleText);
}

function uniqueRepoNames(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function uniqueLogins(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return value?.toLowerCase() === login.toLowerCase();
}

function sameRepo(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function isMaintainerAssociation(value: string | null | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function sanitizeRoleText(value: string): string {
  const redacted = value
    .replace(/(?:\/Users|\/home|\/tmp)\/[^\s"',;)]*|[A-Za-z]:\\Users\\[^\s"',;)]*/g, "<redacted-path>")
    .replace(/\b(?:ghp_|github_pat_|gts_|glpat-|sk-)[A-Za-z0-9_=-]{8,}/g, "<redacted-token>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted-token>");
  if (/\b(seed phrase|mnemonic|private key|raw trust|trust score|wallet|hotkey|coldkey|payout|reward estimate|farming|private reviewability|public score estimate)\b/i.test(redacted)) return "<redacted>";
  return redacted.slice(0, 200);
}
