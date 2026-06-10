export type MinerCommandState = "ready" | "setup" | "needs_login" | "needs_repo";

export type MinerCommandAction = {
  id: "install" | "status" | "doctor" | "plan" | "preflight" | "packet";
  label: string;
  command: string;
  state: MinerCommandState;
  copyable: boolean;
  boundary: "local-mcp";
};

const MCP_PACKAGE = "@jsonbored/gittensory-mcp";
const FALLBACK_LOGIN = "your-login";
const FALLBACK_REPO = "owner/repo";

export function buildMinerCommandActions(input: {
  login?: string | null;
  repoFullName?: string | null;
}): MinerCommandAction[] {
  const login = safeGitHubLogin(input.login) ?? FALLBACK_LOGIN;
  const repoFullName = safeRepoFullName(input.repoFullName) ?? FALLBACK_REPO;
  const hasLogin = login !== FALLBACK_LOGIN;
  const hasRepo = repoFullName !== FALLBACK_REPO;
  const actions: MinerCommandAction[] = [
    {
      id: "install",
      label: "Install",
      command: `npm install -g ${MCP_PACKAGE}@latest`,
      state: "setup",
      copyable: true,
      boundary: "local-mcp",
    },
    {
      id: "status",
      label: "Status",
      command: "gittensory-mcp status --json",
      state: "ready",
      copyable: true,
      boundary: "local-mcp",
    },
    {
      id: "doctor",
      label: "Doctor",
      command: "gittensory-mcp doctor --json",
      state: "ready",
      copyable: true,
      boundary: "local-mcp",
    },
    {
      id: "plan",
      label: "Plan",
      command: `gittensory-mcp agent plan --login ${login} --json`,
      state: hasLogin ? "ready" : "needs_login",
      copyable: hasLogin,
      boundary: "local-mcp",
    },
    {
      id: "preflight",
      label: "Preflight",
      command: `gittensory-mcp preflight --login ${login} --repo ${repoFullName} --base origin/main --json`,
      state: hasLogin && hasRepo ? "ready" : hasLogin ? "needs_repo" : "needs_login",
      copyable: hasLogin && hasRepo,
      boundary: "local-mcp",
    },
    {
      id: "packet",
      label: "Packet",
      command: `gittensory-mcp agent packet --login ${login} --repo ${repoFullName} --base origin/main --json`,
      state: hasLogin && hasRepo ? "ready" : hasLogin ? "needs_repo" : "needs_login",
      copyable: hasLogin && hasRepo,
      boundary: "local-mcp",
    },
  ];
  return actions.map((action) => ({ ...action, command: sanitizeMinerCommand(action.command) }));
}

function safeGitHubLogin(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(text) ? text : null;
}

function safeRepoFullName(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : null;
}

function sanitizeMinerCommand(command: string): string {
  return command
    .replace(/(?:~\/|[A-Za-z]:\\)[^\s"'`,;)]+/g, "<local-path>")
    .replace(
      /(^|[\s"'`=])\/(?:[^\s"'`,;)]+(?:\/[^\s"'`,;)]+)*)/g,
      (_, prefix) => `${prefix}<local-path>`,
    )
    .replace(
      // Only redact actual `term=value` / `term: value` secret leakage. The assignment is required so
      // that legitimate login/repo names containing these words (e.g. a repo named "wallet-adapter" or
      // login "trust-score" -- already validated upstream) are not corrupted into broken commands.
      /\b(?:wallet|hotkey|coldkey|mnemonic|raw[-_\s]?trust|private[-_\s]?reviewability|trust[-_\s]?score)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"'`,;)]+)/gi,
      "[redacted]",
    );
}
