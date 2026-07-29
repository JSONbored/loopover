// Workers-safe registry for the self-host instance-diagnostics capabilities (#9522), mirroring
// src/mcp/redeploy-companion-registry.ts and private-config-admin-registry.ts exactly: nullable function
// slots, and this module never imports a node builtin itself, so it is safe in the Cloudflare Workers
// bundle. Only the self-host Node entry (src/server.ts) fills the slots.
//
// Four independent slots rather than one object, for the same reason the redeploy trigger and the secret
// rotator are separate: a host that can report status but has no backup volume mounted must leave
// `backupStatus` null and answer "not configured" for that one tool, not fail all four.
//
// Unset (cloud, or a self-host deployment without the capability wired) means the slot stays null and
// src/mcp/server.ts's admin tool reports a structured `configured: false` rather than throwing.

/** App version vs the orb-manifest target, uptime, readiness, component health, queue depth. */
export type InstanceStatusReader = () => Promise<Record<string, unknown>>;

/** The read-only check battery: secrets, GitHub auth, datastore reachability, mounts, skew, disk. */
export type InstanceDoctorRunner = () => Promise<{ ok: boolean; checks: { name: string; status: "pass" | "warn" | "fail"; detail?: string }[] }>;

/** A BOUNDED log tail. The implementation is responsible for the byte cap and the redaction scrub. */
export type InstanceLogTailer = (options: { lines: number; since?: string | undefined }) => Promise<{ lines: string[]; truncated: boolean }>;

/** Backup artifacts on disk, newest first. */
export type InstanceBackupStatusReader = () => Promise<Record<string, unknown>>;

let statusReader: InstanceStatusReader | null = null;
let doctorRunner: InstanceDoctorRunner | null = null;
let logTailer: InstanceLogTailer | null = null;
let backupStatusReader: InstanceBackupStatusReader | null = null;

export function setInstanceStatusReader(reader: InstanceStatusReader | null): void {
  statusReader = reader;
}

export function getInstanceStatusReader(): InstanceStatusReader | null {
  return statusReader;
}

export function setInstanceDoctorRunner(runner: InstanceDoctorRunner | null): void {
  doctorRunner = runner;
}

export function getInstanceDoctorRunner(): InstanceDoctorRunner | null {
  return doctorRunner;
}

export function setInstanceLogTailer(tailer: InstanceLogTailer | null): void {
  logTailer = tailer;
}

export function getInstanceLogTailer(): InstanceLogTailer | null {
  return logTailer;
}

export function setInstanceBackupStatusReader(reader: InstanceBackupStatusReader | null): void {
  backupStatusReader = reader;
}

export function getInstanceBackupStatusReader(): InstanceBackupStatusReader | null {
  return backupStatusReader;
}

/** Test-only: drop every slot so one test's wiring cannot leak into the next. */
export function resetInstanceDiagnosticsForTesting(): void {
  statusReader = null;
  doctorRunner = null;
  logTailer = null;
  backupStatusReader = null;
}
