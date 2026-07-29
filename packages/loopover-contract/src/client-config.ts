// The one description of how a client connects to LoopOver (#9526).
//
// Three connection modes -- the stdio gateway, the remote streamable-http endpoint, and the miner's own
// stdio server -- times five client hosts, each with its own config file, language, and server-map shape.
// That is a 14-cell grid, and before this it was written out by hand in four places: `clientSnippet()` in
// the stdio bin, the mcp-clients docs page, and both package READMEs. Each copy drifted on its own
// schedule; the docs page never mentioned the remote endpoint's auth at all.
//
// So the grid lives here, as data, and every surface renders it: `init-client --print` reads this, and
// scripts/gen-mcp-client-config.ts writes the docs and README blocks from it under a --check drift guard.
// Adding a host or a mode is one entry in this file, and every surface that describes it moves together.
import { DEFAULT_LOOPOVER_API_URL } from "./cli-config.js";

/** How a client reaches LoopOver. Ordered as a reader should consider them: local default first. */
export const CONNECTION_MODES = ["stdio", "remote", "miner"] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

/** The MCP client hosts `init-client` can print for. */
export const CLIENT_HOSTS = ["codex", "claude", "cursor", "mcp", "vscode"] as const;
export type ClientHost = (typeof CLIENT_HOSTS)[number];

/**
 * The server-map shape a host expects. Three genuinely different shapes, which is the whole reason a single
 * hand-written snippet could never serve every host: Codex reads TOML tables, most JSON hosts read
 * `mcpServers`, and VS Code reads `servers` with an explicit transport `type`.
 */
type HostShape = "toml" | "mcpServers" | "servers";

export type ClientHostSpec = {
  title: string;
  /** Where the snippet goes. Rendered as the docs code block's filename. */
  file: string;
  /** Where a REMOTE entry goes, when that is a different file from the stdio one. */
  remoteFile?: string;
  lang: "toml" | "json";
  shape: HostShape;
  /** Hosts that cannot talk streamable-http are stdio-only; the grid must not print config that will fail. */
  supportsRemote: boolean;
  /** A caveat that applies only to this host's remote entry. */
  remoteNote?: string;
};

export const CLIENT_HOST_SPEC: Record<ClientHost, ClientHostSpec> = {
  codex: {
    title: "Codex (OpenAI)",
    file: "~/.codex/config.toml",
    lang: "toml",
    shape: "toml",
    supportsRemote: true,
    remoteNote: "Codex releases before its RMCP client became the default also need `experimental_use_rmcp_client = true` at the top level of config.toml.",
  },
  // Claude Desktop reaches remote servers through its connectors UI rather than a config file, so the
  // remote snippet is Claude Code's project-scoped .mcp.json — the one place pasting it actually works.
  claude: { title: "Claude Desktop / Claude Code", file: "claude_desktop_config.json", remoteFile: ".mcp.json", lang: "json", shape: "mcpServers", supportsRemote: true },
  cursor: { title: "Cursor", file: ".cursor/mcp.json", lang: "json", shape: "mcpServers", supportsRemote: true },
  // The generic `mcpServers` shape, for stdio hosts that expect it but are not one of the named three.
  // STDIO-ONLY, deliberately: `mcpServers` is a de-facto stdio convention, and the remote dialects differ
  // per host (Codex's `bearer_token_env_var` versus the JSON hosts' `headers`). Printing a remote block for
  // an unnamed host would be guessing, and a snippet that fails on paste is worse than no snippet -- the
  // stdio gateway serves the remote tools to those hosts anyway.
  mcp: { title: "Other `mcpServers` hosts", file: "mcp.json", lang: "json", shape: "mcpServers", supportsRemote: false },
  vscode: { title: "VS Code", file: ".vscode/mcp.json", lang: "json", shape: "servers", supportsRemote: true },
};

/** The config file a given pair's snippet belongs in. */
export function clientConfigFile(host: ClientHost, mode: ConnectionMode): string {
  const spec = CLIENT_HOST_SPEC[host];
  return CONNECTION_MODE_SPEC[mode].transport === "http" ? (spec.remoteFile ?? spec.file) : spec.file;
}

export type ConnectionModeSpec = {
  title: string;
  /** One sentence a reader can choose by. */
  summary: string;
  /** The key the server appears under in the client's server map. */
  serverKey: string;
  transport: "stdio" | "http";
  /** stdio modes only: the executable. Absent for a remote mode, which starts no process. */
  command?: string;
  /** Required, not optional: `args: []` is a real answer, and an absent one would make every consumer
   *  write the same `?? []` fallback -- a branch with nothing on the other side of it. */
  args: readonly string[];
  /** Anything a reader must do besides paste the snippet. */
  notes: readonly string[];
};

/** The remote endpoint. Same origin the server card advertises, so the two can never disagree. */
export const REMOTE_MCP_URL = `${DEFAULT_LOOPOVER_API_URL}/mcp`;

/**
 * The env var the remote endpoint's bearer token comes from.
 *
 * Deliberately an env-var REFERENCE, never a literal: a config file with a pasted token in it is a token
 * in your shell history, your backups, and eventually a screenshot. `loopover-mcp login` stores a session
 * for the stdio modes; a remote client reads this variable instead.
 */
export const REMOTE_TOKEN_ENV_VAR = "LOOPOVER_API_TOKEN";

export const CONNECTION_MODE_SPEC: Record<ConnectionMode, ConnectionModeSpec> = {
  stdio: {
    title: "Local stdio (gateway)",
    summary:
      "The recommended default. Runs `loopover-mcp` on your machine, keeps auth and git analysis local, and — once you have run `loopover-mcp login` — mounts the remote tool set too, so one entry serves every tool your session entitles you to.",
    serverKey: "loopover",
    transport: "stdio",
    command: "loopover-mcp",
    args: ["--stdio"],
    notes: [
      "Run `loopover-mcp login` before starting the client; without a session you get the local-git tools only, plus an advisory resource explaining how to get the rest.",
      "Pass `--no-remote` to keep the server purely local and skip the remote mount entirely.",
      "Assumes `loopover-mcp` is on your PATH; pass `--command /absolute/path/to/loopover-mcp` if your client does not inherit your shell PATH.",
    ],
  },
  remote: {
    title: "Remote streamable-http",
    summary:
      "For agents that run in the cloud, or anywhere you do not want a local Node process. Connects straight to the hosted server; the local-git tools are not available over this transport because there is no local checkout to read.",
    serverKey: "loopover",
    transport: "http",
    args: [],
    notes: [
      `Authenticates with a bearer token read from \`${REMOTE_TOKEN_ENV_VAR}\` — the same variable the CLI honors. Set it in the environment your client starts in; never paste the token into the config file.`,
      "Tools whose work is a local git operation are absent here by design. Use the stdio mode if you need them.",
    ],
  },
  miner: {
    title: "Miner stdio",
    summary:
      "AMS's own local state-visibility tools, as a separate stdio server. It stays separate on purpose: it reads this machine's SQLite state and shares no code or network path with the hosted server.",
    serverKey: "loopover-miner",
    transport: "stdio",
    command: "loopover-miner-mcp",
    args: [],
    notes: [
      "Takes no flags and needs no login — everything it reads is already on this machine.",
      "A dual-role operator runs this alongside the stdio gateway; the two entries coexist in one client config.",
    ],
  },
};

/** A mode a host cannot actually speak is not printed — a snippet that fails on paste is worse than none. */
export function supportsConnectionMode(host: ClientHost, mode: ConnectionMode): boolean {
  return CONNECTION_MODE_SPEC[mode].transport === "stdio" || CLIENT_HOST_SPEC[host].supportsRemote;
}

/** Every (host, mode) pair that has a snippet, in a stable order for generated output. */
export function clientConfigMatrix(): Array<{ host: ClientHost; mode: ConnectionMode }> {
  return CLIENT_HOSTS.flatMap((host) => CONNECTION_MODES.filter((mode) => supportsConnectionMode(host, mode)).map((mode) => ({ host, mode })));
}

/** A TOML server entry is FLAT by construction -- strings and string arrays only, which is what lets
 *  tomlTable stay a dozen lines with no escape hatch for a shape it cannot render. */
type TomlEntry = Record<string, string | readonly string[]>;

/** The stdio entry both dialects share. */
function stdioEntry(mode: ConnectionMode, command: string): { command: string; args: readonly string[] } {
  return { command, args: CONNECTION_MODE_SPEC[mode].args };
}

export type ClientConfigOptions = {
  /** Overrides the mode's default executable, for a client that does not inherit your shell PATH. */
  command?: string;
};

/**
 * The config snippet for one (host, mode) pair.
 *
 * Throws on a pair with no snippet rather than emitting a plausible-looking one — printing config that
 * cannot work is the failure this whole module exists to prevent.
 */
export function clientConfigSnippet(host: ClientHost, mode: ConnectionMode, options: ClientConfigOptions = {}): string {
  if (!supportsConnectionMode(host, mode)) {
    throw new Error(`${CLIENT_HOST_SPEC[host].title} cannot connect over the ${CONNECTION_MODE_SPEC[mode].title} mode.`);
  }
  const spec = CONNECTION_MODE_SPEC[mode];
  const hostSpec = CLIENT_HOST_SPEC[host];
  const remote = spec.transport === "http";
  const command = options.command ?? spec.command ?? "";

  if (hostSpec.shape === "toml") {
    // Codex names the token's environment variable in its own key and reads it itself.
    const entry: TomlEntry = remote ? { url: REMOTE_MCP_URL, bearer_token_env_var: REMOTE_TOKEN_ENV_VAR } : stdioEntry(mode, command);
    return tomlTable(`mcp_servers.${spec.serverKey}`, entry);
  }

  // The JSON hosts want the header spelled out instead. Same secret, same never-in-the-file rule.
  // `servers` hosts require the transport type on stdio entries too; `mcpServers` hosts infer it from
  // `command`, and adding it there would only be noise in a config people read.
  const entry = remote
    ? { type: "http", url: REMOTE_MCP_URL, headers: { Authorization: `Bearer \${${REMOTE_TOKEN_ENV_VAR}}` } }
    : { ...(hostSpec.shape === "servers" ? { type: "stdio" } : {}), ...stdioEntry(mode, command) };
  return compactStringArrays(JSON.stringify({ [hostSpec.shape === "servers" ? "servers" : "mcpServers"]: { [spec.serverKey]: entry } }, null, 2));
}

/**
 * Collapse a short array of strings back onto one line.
 *
 * JSON.stringify's pretty printer gives every element its own row, which turns `"args": ["--stdio"]` into
 * four lines of a block people read at least as often as they paste it. Done here rather than in the docs
 * generator so the CLI's output and the docs' blocks stay byte-identical -- a formatting difference between
 * the two is exactly the kind of drift this module exists to remove.
 */
export function compactStringArrays(json: string): string {
  return json.replace(/\[\n(\s+)("(?:[^"\\]|\\.)*"(?:,\n\1"(?:[^"\\]|\\.)*")*)\n\s+\]/g, (whole, _indent: string, body: string) => {
    const inline = `[${body.split(/,\n\s+/).join(", ")}]`;
    return inline.length <= 72 ? inline : whole;
  });
}

/**
 * A TOML table for one server entry.
 *
 * Hand-rolled rather than pulled from a TOML library on purpose: @loopover/contract is a zod-only leaf
 * package that both a Cloudflare Worker and a published CLI depend on, and it is not worth a dependency to
 * serialize strings and string arrays. TomlEntry is what keeps that honest -- a nested table would need a
 * second pass to place it after its parent's scalars, so the type forbids one rather than a runtime guard
 * apologizing for one that can never arrive.
 */
function tomlTable(tableName: string, entry: TomlEntry): string {
  const lines = [`[${tableName}]`];
  for (const [key, value] of Object.entries(entry)) {
    lines.push(typeof value === "string" ? `${key} = ${JSON.stringify(value)}` : `${key} = [${value.map((item) => JSON.stringify(item)).join(", ")}]`);
  }
  return lines.join("\n");
}
