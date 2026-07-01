import { sha256Hex } from "../utils/crypto";
import { setCurrentOtelSpanAttributes, withOtelSpan } from "./otel";

const INSTALLATION_HASH_SEED = "github-installation:";

type ReviewTraceInput = {
  installationId?: number | string | null | undefined;
  repoFullName?: string | null | undefined;
  pullNumber?: number | null | undefined;
  operation?: string | undefined;
  agent?: string | undefined;
  decisionOutcome?: string | undefined;
};

function normalizeInstallationId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[0-9]+$/.test(trimmed) ? trimmed : undefined;
}

export function hashedInstallationIdWith(
  value: unknown,
  digestHex: (input: string) => string,
): string | undefined {
  const normalized = normalizeInstallationId(value);
  if (!normalized) return undefined;
  return digestHex(`${INSTALLATION_HASH_SEED}${normalized}`).slice(0, 16);
}

export async function hashedInstallationId(value: unknown): Promise<string | undefined> {
  const normalized = normalizeInstallationId(value);
  if (!normalized) return undefined;
  return (await sha256Hex(`${INSTALLATION_HASH_SEED}${normalized}`)).slice(0, 16);
}

export async function reviewTraceAttributes(
  input: ReviewTraceInput,
): Promise<Record<string, unknown>> {
  const attrs: Record<string, unknown> = {};
  if (input.repoFullName) attrs["github.repository"] = input.repoFullName;
  if (input.pullNumber !== null && input.pullNumber !== undefined)
    attrs["github.pull_request.number"] = input.pullNumber;
  const installationHash = await hashedInstallationId(input.installationId);
  if (installationHash) attrs["github.installation_id_hash"] = installationHash;
  if (input.operation) attrs["gittensory.operation"] = input.operation;
  if (input.agent) attrs["gittensory.agent"] = input.agent;
  if (input.decisionOutcome) attrs["gittensory.decision_outcome"] = input.decisionOutcome;
  return attrs;
}

export async function withReviewPipelineSpan<T>(
  name: string,
  input: ReviewTraceInput,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withOtelSpan(name, await reviewTraceAttributes(input), fn);
}

export async function setReviewPipelineSpanOutcome(
  input: Pick<ReviewTraceInput, "decisionOutcome">,
): Promise<void> {
  setCurrentOtelSpanAttributes(await reviewTraceAttributes(input));
}
