// loopover_admin_get_config (#9517 pilot).
//
// The self-host operator surface, and the pilot's proof that `auth` and `availability` are real
// enforcement inputs rather than documentation. This tool is registered only when
// LOOPOVER_MCP_ADMIN_ENABLED is truthy AND requires actor === "mcp-admin" at call time -- defense in
// depth, so enabling the flag alone grants nothing to a caller holding only the ordinary MCP token.
//
// availability "selfhost" is physics, not policy: reading the private config needs an fs-backed
// capability the Cloudflare Workers bundle cannot provide, which is why it reaches the filesystem
// through the nullable registry in src/mcp/private-config-admin-registry.ts that only the self-host
// Node entry ever fills.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { CONFIG_ADMIN_READ_SCOPES, CONFIG_ADMIN_WRITE_SCOPES, ROTATABLE_SECRET_NAMES } from "../enums.js";

/**
 * `repoFullName` is CONDITIONALLY required -- mandatory for scope "effective" and "repo", ignored
 * for "global" -- and that dependency is enforced at runtime by a throw rather than by this schema.
 * Expressing it here (a discriminated union, or a refinement) would change the emitted JSON Schema
 * from a flat object into a composed one, which is a wire change to the advertised inputSchema.
 * Left flat on purpose; the runtime check remains the authority.
 */
export const AdminGetConfigInput = z.object({
  scope: z.enum(CONFIG_ADMIN_READ_SCOPES),
  repoFullName: z.string().min(3).max(200).optional(),
});

/**
 * Three distinct payloads share this shape, which is why only `configured` is required:
 *
 *  1. not configured (LOOPOVER_REPO_CONFIG_DIR unset) -- `{ configured: false }` and nothing else;
 *  2. scope "effective" -- adds found/path/content/warnings, with `path` always null because a
 *     merged view corresponds to no single file;
 *  3. scope "global" | "repo" -- adds found/path/content, and never `warnings` (there is no merge
 *     or parse step in a raw file read to warn about).
 */
export const AdminGetConfigOutput = z.looseObject({
  configured: z.boolean(),
  found: z.boolean().optional(),
  path: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
});

export type AdminGetConfigInput = z.infer<typeof AdminGetConfigInput>;
export type AdminGetConfigOutput = z.infer<typeof AdminGetConfigOutput>;

export const adminGetConfigTool = defineTool({
  name: "loopover_admin_get_config",
  title: "Read private instance config",
  description:
    "Self-hosted-operator only. Read this instance's own private .loopover.yml config: the merged effective config for a repo (shared base + global default + per-repo override), or just the raw global-default layer, or just the raw per-repo layer. Requires LOOPOVER_MCP_ADMIN_TOKEN. Returns configured=false if LOOPOVER_REPO_CONFIG_DIR is unset.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  input: AdminGetConfigInput,
  output: AdminGetConfigOutput,
});

// ── write config ────────────────────────────────────────────────────────────────────────────────

/** Unlike the read tool, write scope is only ever "global" | "repo" -- there is no single file an
 *  "effective" write could target, since that view is a merge of several layers. */
export const AdminWriteConfigInput = z.object({
  scope: z.enum(CONFIG_ADMIN_WRITE_SCOPES),
  repoFullName: z.string().min(3).max(200).optional(),
  content: z.string().max(256 * 1024),
  dryRun: z.boolean().optional(),
});

export const AdminWriteConfigOutput = z.looseObject({
  configured: z.boolean(),
  ok: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  path: z.string().optional(),
  backupPath: z.string().nullable().optional(),
  error: z.string().optional(),
});

export type AdminWriteConfigInput = z.infer<typeof AdminWriteConfigInput>;
export type AdminWriteConfigOutput = z.infer<typeof AdminWriteConfigOutput>;

export const adminWriteConfigTool = defineTool({
  name: "loopover_admin_write_config",
  title: "Write private instance config",
  description:
    "Self-hosted-operator only. Write this instance's own private global-default or per-repo .loopover.yml config: validated, a timestamped backup of any existing file first, atomic write. Set dryRun=true to validate without writing. Requires LOOPOVER_MCP_ADMIN_TOKEN. The config mount stays read-only (:ro) by default in docker-compose.yml -- an operator must flip it to :rw themselves before a real (non-dry-run) write can succeed.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: AdminWriteConfigInput,
  output: AdminWriteConfigOutput,
});

// ── list config backups ─────────────────────────────────────────────────────────────────────────

export const AdminListConfigBackupsInput = z.object({
  scope: z.enum(CONFIG_ADMIN_WRITE_SCOPES),
  repoFullName: z.string().min(3).max(200).optional(),
});

export const AdminListConfigBackupsOutput = z.looseObject({
  configured: z.boolean(),
  backups: z.array(z.looseObject({ name: z.string(), path: z.string(), mtimeMs: z.number() })).optional(),
});

export type AdminListConfigBackupsInput = z.infer<typeof AdminListConfigBackupsInput>;
export type AdminListConfigBackupsOutput = z.infer<typeof AdminListConfigBackupsOutput>;

export const adminListConfigBackupsTool = defineTool({
  name: "loopover_admin_list_config_backups",
  title: "List private config backups",
  description:
    "Self-hosted-operator only. List timestamped backups (newest first) created by loopover_admin_write_config for the global-default or a specific repo's config. Requires LOOPOVER_MCP_ADMIN_TOKEN.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  input: AdminListConfigBackupsInput,
  output: AdminListConfigBackupsOutput,
});

// ── trigger redeploy ────────────────────────────────────────────────────────────────────────────

export const AdminTriggerRedeployInput = z.object({
  // #7723: the same character class deploy-selfhost-image.sh's own validate_inputs enforces (no
  // whitespace/quote/backslash/compose-interpolation/shell-metacharacter chars) -- redundant with
  // both that script's own check and the companion's own isSafeImageOverride, but a caller gets a
  // clear MCP-level error instead of an opaque host-side rejection two hops away.
  image: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\s"'\\${}`;|&<>]+$/, "must not contain whitespace, quotes, backslashes, compose interpolation, or shell metacharacters")
    .optional(),
});

export const AdminTriggerRedeployOutput = z.looseObject({
  configured: z.boolean(),
  ok: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
  log: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export type AdminTriggerRedeployInput = z.infer<typeof AdminTriggerRedeployInput>;
export type AdminTriggerRedeployOutput = z.infer<typeof AdminTriggerRedeployOutput>;

export const adminTriggerRedeployTool = defineTool({
  name: "loopover_admin_trigger_redeploy",
  title: "Trigger instance redeploy",
  description:
    "Self-hosted-operator only. Trigger a real redeploy of this instance (pull the published image, restart, wait for health) via the host-side redeploy companion (#7723) -- NOT via the Docker socket, which is never mounted into this container. Optional `image` pins a specific tag/digest; omitted uses the companion's own default (the currently-configured LOOPOVER_IMAGE). Requires LOOPOVER_MCP_ADMIN_TOKEN. Returns configured=false if REDEPLOY_COMPANION_TOKEN is unset or the companion isn't reachable at REDEPLOY_COMPANION_SOCKET_PATH -- see systemd/loopover-redeploy-companion.service.example to set it up. A real redeploy restarts this very process; the tool call itself completes (with the companion's full log) before that restart happens, since the companion waits for the new container to report healthy before responding.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: AdminTriggerRedeployInput,
  output: AdminTriggerRedeployOutput,
});

/**
 * `loopover_admin_rotate_secret` (#9543) -- migrated into the registry by #9522, which found it was the one
 * live remote tool #9518 missed: it was registered in src/mcp/server.ts with inline shapes and had its own
 * test file, but no contract entry, so validate:mcp never saw it.
 *
 * The VALUE rules are not cosmetic and are duplicated on purpose: the companion's own isValidSecretValue
 * enforces them host-side too, so a caller gets a clear MCP-level rejection while the host still refuses
 * independently if this layer is ever bypassed. src/selfhost/load-file-secrets.ts only `.trim()`s the file,
 * so a label or comment line above the value silently becomes part of the credential.
 */
export const AdminRotateSecretInput = z.object({
  secret: z.enum(ROTATABLE_SECRET_NAMES),
  value: z
    .string()
    .min(1)
    .max(4096)
    .refine((candidate) => !/[\r\n]/.test(candidate), "must be a single line -- a comment or label line would become part of the credential")
    .refine((candidate) => candidate.trim() === candidate, "must not have leading or trailing whitespace")
    .refine((candidate) => !candidate.startsWith("#"), "must not start with '#' -- that is a comment, not a credential"),
});

export const AdminRotateSecretOutput = z.looseObject({
  configured: z.boolean(),
  ok: z.boolean().optional(),
  secret: z.string().optional(),
  backupPath: z.string().optional(),
  error: z.string().optional(),
});

export type AdminRotateSecretInput = z.infer<typeof AdminRotateSecretInput>;
export type AdminRotateSecretOutput = z.infer<typeof AdminRotateSecretOutput>;

export const adminRotateSecretTool = defineTool({
  name: "loopover_admin_rotate_secret",
  title: "Rotate an instance secret",
  description:
    "Self-hosted-operator only. Rotate one of this instance's own secret files (e.g. claude_code_oauth_token) in place on the host, via the redeploy companion (#7723) -- the app container cannot write these itself, the Compose secrets mount is read-only. The value must be the bare credential: a single line, no comment or label line, no surrounding whitespace (the loader only trims, so anything else silently becomes part of the credential). Backs the previous value up first, and writes in place so the running container's inode-pinned bind mount sees it immediately. For claude_code_oauth_token no restart is needed -- the token is re-read per AI call. Requires LOOPOVER_MCP_ADMIN_TOKEN. Returns configured=false if REDEPLOY_COMPANION_TOKEN is unset or the companion isn't reachable.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: AdminRotateSecretInput,
  output: AdminRotateSecretOutput,
});
