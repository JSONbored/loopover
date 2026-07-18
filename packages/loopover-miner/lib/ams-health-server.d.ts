import type { Server } from "node:http";

export type ReadinessProbe = { name: string; check: () => Promise<boolean> };

export type Readiness = {
  ok: boolean;
  checks: Record<string, boolean>;
  durationsMs: Record<string, number>;
};

export function buildHealthBody(): { status: "ok" };

export function readiness(probes?: ReadinessProbe[]): Promise<Readiness>;

export function createAmsHealthHandler(
  probes?: ReadinessProbe[],
): (req: { method?: string; url?: string }, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }) => Promise<void>;

export function startAmsHealthServer(options?: { port?: number; host?: string; probes?: ReadinessProbe[] }): Promise<Server>;
