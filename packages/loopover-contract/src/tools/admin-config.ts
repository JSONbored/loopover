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
import { CONFIG_ADMIN_READ_SCOPES } from "../enums.js";

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
