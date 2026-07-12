import type { LocalWriteActionSpec } from "@jsonbored/gittensory-engine";

export type ExecuteLocalWriteResult = {
  action: string;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

export function executeLocalWrite(
  spec: LocalWriteActionSpec,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ExecuteLocalWriteResult>;
