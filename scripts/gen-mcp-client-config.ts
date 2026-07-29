#!/usr/bin/env node
// Generate every client-config surface from the @loopover/contract grid (#9526).
//
// Same one-source pattern as gen-mcp-tool-reference.ts, applied to the other half of the docs: how you
// CONNECT, rather than what you get once connected. Four places used to spell out the same server-map
// snippets by hand -- `clientSnippet()` in the stdio bin, apps/loopover-ui/content/docs/mcp-clients.mdx, and
// both package READMEs -- and they had already drifted: the docs page documented no remote auth at all, and
// nothing described the gateway's remote mount because the gateway did not exist when the prose was written.
//
// Surfaces:
//   1. apps/loopover-ui/content/docs/mcp-clients.mdx -- a section per host, one code block per mode
//   2. packages/loopover-mcp/README.md               -- the stdio + remote config blocks
//   3. packages/loopover-miner/README.md             -- the dual-role (gateway + miner) combined block
//
// `--check` regenerates in memory and diffs, exiting 1 on drift; test:ci runs it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLIENT_HOSTS,
  CLIENT_HOST_SPEC,
  CONNECTION_MODES,
  CONNECTION_MODE_SPEC,
  REMOTE_MCP_URL,
  clientConfigFile,
  clientConfigSnippet,
  compactStringArrays,
  supportsConnectionMode,
  type ClientHost,
  type ConnectionMode,
} from "@loopover/contract/client-config";

const CHECK = process.argv.includes("--check");
const ROOT = process.cwd();

// MDX is not HTML: an `<!-- -->` comment is parsed as JSX and blows up the page, so the docs markers use the
// expression form. The READMEs are plain markdown and keep the HTML form the other generators use.
const MDX_BEGIN = "{/* GENERATED:MCP-CLIENT-CONFIG:BEGIN — edit packages/loopover-contract/src/client-config.ts, then `npm run mcp:client-config` */}";
const MDX_END = "{/* GENERATED:MCP-CLIENT-CONFIG:END */}";
const MD_BEGIN = "<!-- GENERATED:MCP-CLIENT-CONFIG:BEGIN — edit packages/loopover-contract/src/client-config.ts, then `npm run mcp:client-config` -->";
const MD_END = "<!-- GENERATED:MCP-CLIENT-CONFIG:END -->";

/** Backticks and `${` would both terminate or interpolate inside an MDX `code={\`...\`}` template literal. */
function escapeForMdxTemplate(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function mdxCodeBlock(filename: string, lang: string, code: string): string {
  const attributes = [...(filename ? [`  filename=${JSON.stringify(filename)}`] : []), `  lang=${JSON.stringify(lang)}`];
  return `<CodeBlock\n${attributes.join("\n")}\n  code={\`${escapeForMdxTemplate(code)}\`}\n/>`;
}

/** The docs page body: choose a mode, then a host, with each host's caveats where the reader will hit them. */
export function docsSection(): string {
  const lines: string[] = [
    "## Generate config",
    "",
    "Every block on this page is what `init-client` prints. It prints config only — it never edits your client files.",
    "",
    mdxCodeBlock(
      "",
      "bash",
      CONNECTION_MODES.flatMap((mode) =>
        CLIENT_HOSTS.filter((host) => supportsConnectionMode(host, mode)).map((host) => `loopover-mcp init-client --print ${host}${mode === "stdio" ? "" : ` --mode ${mode}`}`),
      ).join("\n"),
    ),
    "",
  ];
  for (const mode of CONNECTION_MODES) {
    const spec = CONNECTION_MODE_SPEC[mode];
    lines.push(`## ${spec.title}`, "", spec.summary, "");
    for (const note of spec.notes) lines.push(`- ${note}`);
    lines.push("");
    for (const host of CLIENT_HOSTS.filter((candidate) => supportsConnectionMode(candidate, mode))) {
      const hostSpec = CLIENT_HOST_SPEC[host];
      // The mode goes in the heading, not just the section, so the anchors stay unique across the page.
      lines.push(`### ${hostSpec.title} (${mode})`, "");
      lines.push(mdxCodeBlock(clientConfigFile(host, mode), hostSpec.lang, clientConfigSnippet(host, mode)), "");
      const remoteNote = spec.transport === "http" ? hostSpec.remoteNote : undefined;
      if (remoteNote) lines.push(remoteNote, "");
    }
  }
  lines.push("Every block above comes from the same grid the CLI prints from, so a snippet copied from here and one printed by `init-client` can never disagree.");
  return lines.join("\n");
}

function fence(lang: string, code: string): string {
  return "```" + lang + "\n" + code + "\n```";
}

/** The stdio README: how to wire the gateway, and the remote endpoint for anyone who cannot run a process. */
export function stdioReadmeSection(): string {
  const lines: string[] = [];
  lines.push(
    `\`init-client --print <host> [--mode <mode>]\` prints the MCP config for a host: ${CLIENT_HOSTS.map((host) => `\`${host}\``).join(", ")}. Modes are ${CONNECTION_MODES.map((mode) => `\`${mode}\``).join(", ")}, defaulting to \`stdio\`. It prints config only; it never edits client files.`,
    "",
  );
  for (const mode of ["stdio", "remote"] as const) {
    const spec = CONNECTION_MODE_SPEC[mode];
    lines.push(`#### ${spec.title}`, "", spec.summary, "");
    lines.push(`${CLIENT_HOST_SPEC.claude.title}, in \`${clientConfigFile("claude", mode)}\`:`, "");
    lines.push(fence("json", clientConfigSnippet("claude", mode)), "");
    for (const note of spec.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push(`The remote endpoint is \`${REMOTE_MCP_URL}\` — the same URL \`/.well-known/mcp.json\` advertises.`);
  return lines.join("\n");
}

/**
 * The miner README's dual-role block: the gateway and the miner server in ONE client config.
 *
 * Built by merging the two modes' entries rather than by writing a third snippet, because "run both" is
 * exactly the case a hand-written third copy gets wrong first.
 */
export function minerReadmeSection(): string {
  const merged = { mcpServers: {} as Record<string, unknown> };
  for (const mode of ["stdio", "miner"] as const) {
    Object.assign(merged.mcpServers, (JSON.parse(clientConfigSnippet("claude", mode)) as { mcpServers: Record<string, unknown> }).mcpServers);
  }
  return [
    `\`${CONNECTION_MODE_SPEC.stdio.command}\` (ORB's hosted contributor-workflow tools) and \`${CONNECTION_MODE_SPEC.miner.command}\` (AMS's own local state-visibility tools above) run as two separate stdio servers in the same MCP client session — the dual-role case for an operator running both ORB and AMS on one box. Generate ORB's half with \`loopover-mcp init-client --print claude\` (see the [\`@loopover/mcp\` README](../loopover-mcp/README.md#client-config)); \`${CONNECTION_MODE_SPEC.miner.command}\` takes no flags, so its entry is just the bin name. Combined:`,
    "",
    fence("json", compactStringArrays(JSON.stringify(merged, null, 2))),
    "",
    `\`${CONNECTION_MODE_SPEC.stdio.serverKey}\` exposes ORB's hosted contributor-workflow tools (issue ranking, PR packet prep, decision packs) and, once you have run \`loopover-mcp login\`, the remote tool set it mounts. \`${CONNECTION_MODE_SPEC.miner.serverKey}\` exposes AMS's own local state-visibility tools listed above (portfolio dashboard, claims, audit feed, run state, plans, calibration) — a fully separate, 100% local tool surface with no shared code or network calls between the two.`,
    "",
    `Both follow the same \`loopover_*\` naming convention (\`loopover_...\` vs. \`loopover_miner_...\`), but back onto different stores: ORB's tools read the hosted loopover backend, AMS's tools read this machine's own local SQLite files (see [Local storage](#local-storage)) — a handful of AMS tools even name the ORB tool they mirror (e.g. \`loopover_miner_get_run_state\` is the read-only analog of \`loopover_get_automation_state\`) so the relationship is explicit at the point of use, not just here.`,
  ].join("\n");
}

export function replaceBetweenMarkers(source: string, replacement: string, begin: string, end: string, file: string): string {
  const beginAt = source.indexOf(begin);
  const endAt = source.indexOf(end);
  if (beginAt === -1 || endAt === -1) throw new Error(`${file} is missing the GENERATED:MCP-CLIENT-CONFIG markers.`);
  return source.slice(0, beginAt + begin.length) + "\n\n" + replacement + "\n\n" + source.slice(endAt);
}

const TARGETS: Array<{ file: string; next: (current: string) => string }> = [
  {
    file: "apps/loopover-ui/content/docs/mcp-clients.mdx",
    next: (current) => replaceBetweenMarkers(current, docsSection(), MDX_BEGIN, MDX_END, "apps/loopover-ui/content/docs/mcp-clients.mdx"),
  },
  {
    file: "packages/loopover-mcp/README.md",
    next: (current) => replaceBetweenMarkers(current, stdioReadmeSection(), MD_BEGIN, MD_END, "packages/loopover-mcp/README.md"),
  },
  {
    file: "packages/loopover-miner/README.md",
    next: (current) => replaceBetweenMarkers(current, minerReadmeSection(), MD_BEGIN, MD_END, "packages/loopover-miner/README.md"),
  },
];

function main(): void {
  const drifted: string[] = [];
  for (const target of TARGETS) {
    const path = join(ROOT, target.file);
    const current = readFileSync(path, "utf8");
    const next = target.next(current);
    if (next === current) continue;
    if (CHECK) drifted.push(target.file);
    else writeFileSync(path, next);
  }
  if (CHECK && drifted.length > 0) {
    process.stderr.write(`gen-mcp-client-config: stale generated output in ${drifted.join(", ")} -- run \`npm run mcp:client-config\`.\n`);
    process.exit(1);
  }
  const pairs = CLIENT_HOSTS.flatMap((host) => CONNECTION_MODES.filter((mode) => supportsConnectionMode(host as ClientHost, mode as ConnectionMode)));
  process.stdout.write(`gen-mcp-client-config: ${CHECK ? "checked" : "wrote"} ${TARGETS.length} surface(s) from ${pairs.length} host/mode pairs.\n`);
}

// Importable for tests without running the file's I/O (the same guard gen-command-reference.ts uses).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
