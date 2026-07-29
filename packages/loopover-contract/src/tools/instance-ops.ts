// Self-host instance diagnostics (#9522): status, doctor, log tail, backup status.
//
// availability "selfhost" is physics, not policy, exactly as it is for the config-admin tools: every one of
// these needs something the Cloudflare Workers bundle cannot provide -- the container's own filesystem, its
// process uptime, the host-side redeploy companion, the backup volume. They reach those through nullable
// capability registries that only the self-host Node entry fills, so an unconfigured deployment answers
// `configured: false` rather than throwing.
//
// ORB had no `doctor` before this; the miner has had one for a long time. That asymmetry is the reason an
// operator debugging a self-hosted ORB has had to read container logs by hand.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { INSTANCE_CHECK_STATUSES } from "../enums.js";

export const AdminGetStatusInput = z.object({});

/**
 * Everything here is optional under a required `configured`, matching the config-admin tools' own shape:
 * one payload covers "no capability wired" and "here is the rollup", and a partially-available host (say,
 * a reachable container but an unreadable manifest) fills what it can rather than failing whole.
 */
export const AdminGetStatusOutput = z.looseObject({
  configured: z.boolean(),
  appVersion: z.string().nullable().optional(),
  targetVersion: z.string().nullable().optional().describe("The version orb-manifest.json says this instance should be running."),
  upToDate: z.boolean().optional().describe("False when appVersion lags targetVersion — the signal that a redeploy is due."),
  uptimeSeconds: z.number().nullable().optional(),
  ready: z.boolean().optional().describe("The /ready probe's own verdict."),
  readyDetail: z.record(z.string(), z.unknown()).optional(),
  components: z.array(z.looseObject({ name: z.string(), healthy: z.boolean() })).optional(),
  queueDepth: z.number().nullable().optional(),
  lastRedeployAt: z.string().nullable().optional(),
  error: z.string().optional(),
});

export const adminGetStatusTool = defineTool({
  name: "loopover_admin_get_status",
  title: "Read instance status",
  description:
    "Self-hosted-operator only. One answer for 'what is this instance running and is it healthy': app version against the orb-manifest target (and whether a redeploy is due), uptime, the /ready probe's detail, per-component health, queue depth, and the last redeploy. Read-only and redaction-scrubbed. Requires LOOPOVER_MCP_ADMIN_TOKEN; returns configured=false where the capability is not wired.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  input: AdminGetStatusInput,
  output: AdminGetStatusOutput,
});

export const AdminDoctorInput = z.object({});

/**
 * A flat list of independently-reported checks, not a single pass/fail: an operator needs to know WHICH
 * check failed and why, and a doctor that stops at the first failure hides the rest of the picture. Every
 * check runs; `status` carries its own verdict.
 */
export const AdminDoctorOutput = z.looseObject({
  configured: z.boolean(),
  ok: z.boolean().optional().describe("True when no check reported fail. Warnings do not clear it to false."),
  checks: z
    .array(
      z.looseObject({
        name: z.string(),
        status: z.enum(INSTANCE_CHECK_STATUSES),
        detail: z.string().optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

export const adminDoctorTool = defineTool({
  name: "loopover_admin_doctor",
  title: "Diagnose this instance",
  description:
    "Self-hosted-operator only. The ORB counterpart of the miner's doctor: read-only checks over secret presence and shape, GitHub App auth, database/Redis/Qdrant reachability, the config-dir mount and LOOPOVER_REPO_CONFIG_DIR writability, broker enrollment validity, clock skew, and disk pressure. Every check runs and reports its own pass/warn/fail — nothing is mutated and nothing stops at the first failure. Requires LOOPOVER_MCP_ADMIN_TOKEN.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  input: AdminDoctorInput,
  output: AdminDoctorOutput,
});

export const AdminTailLogsInput = z.object({
  lines: z.number().int().min(1).max(1000).optional().describe("How many trailing lines to return. Defaults to 200, hard-capped at 1000."),
  since: z.string().max(64).optional().describe("Optional lower bound, as the container runtime's own duration or timestamp form (e.g. 15m)."),
});

export const AdminTailLogsOutput = z.looseObject({
  configured: z.boolean(),
  lines: z.array(z.string()).optional(),
  truncated: z.boolean().optional().describe("True when the byte cap cut the tail shorter than the requested line count."),
  error: z.string().optional(),
});

export const adminTailLogsTool = defineTool({
  name: "loopover_admin_tail_logs",
  title: "Tail instance logs",
  description:
    "Self-hosted-operator only. Return a BOUNDED tail of this instance's own logs — capped by both line count and total bytes, and passed through the same redaction scrubbing every other operator surface uses before it leaves the host. There is no follow mode: this returns a snapshot and completes. Requires LOOPOVER_MCP_ADMIN_TOKEN.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  input: AdminTailLogsInput,
  output: AdminTailLogsOutput,
});

export const AdminGetBackupStatusInput = z.object({});

export const AdminGetBackupStatusOutput = z.looseObject({
  configured: z.boolean(),
  lastBackupAt: z.string().nullable().optional(),
  backups: z.array(z.looseObject({ name: z.string(), createdAt: z.string().nullable(), sizeBytes: z.number().nullable() })).optional(),
  error: z.string().optional(),
});

export const adminGetBackupStatusTool = defineTool({
  name: "loopover_admin_get_backup_status",
  title: "Read backup status",
  description:
    "Self-hosted-operator only. When this instance last backed up and what artifacts the backup container has on disk, with sizes. Read-only — it never triggers a backup. Requires LOOPOVER_MCP_ADMIN_TOKEN; returns configured=false where no backup volume is mounted.",
  category: "admin",
  auth: "mcp-admin",
  locality: "remote",
  availability: "selfhost",
  input: AdminGetBackupStatusInput,
  output: AdminGetBackupStatusOutput,
});

export const INSTANCE_OPS_TOOLS = [adminGetStatusTool, adminDoctorTool, adminTailLogsTool, adminGetBackupStatusTool] as const;
