// Node-only client for the host-side redeploy companion (#7723). Talks to a Unix domain socket
// (scripts/redeploy-companion.ts's own protocol) -- this module's `node:net` import must never reach the
// Cloudflare Workers bundle, so src/mcp/server.ts (which IS bundled for Workers) never imports this file
// directly; only src/server.ts (the Node self-host boot entry) does, injecting a real closure into
// src/mcp/redeploy-companion-registry.ts's nullable slot. Mirrors src/selfhost/private-config.ts's own
// read/write helpers -> src/mcp/private-config-admin-registry.ts injection pattern exactly (#7721).
import { createConnection } from "node:net";

export type RedeployCompanionConfig = {
  socketPath: string;
  token: string;
  /** Override for tests only -- production always uses this module's own DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
};

export type RedeployResult = { ok: boolean; exitCode: number | null; error?: string; log: string[] };

/** Result of a host-side secret rotation. `backupPath` is absent when no prior value existed to back up. */
export type RotateSecretResult = { ok: boolean; error?: string; backupPath?: string };

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // a real pull+recreate+health-wait can legitimately take minutes

/** Send one redeploy request and collect the companion's streamed response. Rejects (never resolves with a
 *  fabricated result) on a connection/protocol failure -- the caller (adminTriggerRedeploy) is responsible for
 *  turning that into a clear tool-result error, not this function guessing at one. */
export function triggerRedeploy(config: RedeployCompanionConfig, image: string | undefined): Promise<RedeployResult> {
  return sendCompanionRequest(config, image !== undefined ? { image } : {}, (terminal, log) => ({
    ok: terminal.ok,
    exitCode: terminal.exitCode ?? null,
    ...(terminal.error !== undefined ? { error: terminal.error } : {}),
    log,
  }));
}

/** Rotate one secret file on the host (#9543). Single request/response -- the companion streams no log
 *  lines for this verb, so `log` is always empty and is not part of the result shape. */
export function rotateCompanionSecret(config: RedeployCompanionConfig, secret: string, value: string): Promise<RotateSecretResult> {
  return sendCompanionRequest(config, { action: "rotate-secret", secret, value }, (terminal) => ({
    ok: terminal.ok,
    ...(terminal.error !== undefined ? { error: terminal.error } : {}),
    ...(terminal.backupPath !== undefined ? { backupPath: terminal.backupPath } : {}),
  }));
}

type TerminalLine = { ok: boolean; exitCode?: number | null; error?: string; backupPath?: string };

/** The shared connection lifecycle for every companion verb: connect, write one line-delimited JSON
 *  request, collect any `{"log"}` lines, settle on the first terminal `{"ok"}` line. Extracted (#9543) so a
 *  second verb cannot drift from the first on timeout/close/error handling -- the parts most likely to be
 *  got subtly wrong twice. `shape` maps the terminal line to each verb's own result type. */
function sendCompanionRequest<T>(
  config: RedeployCompanionConfig,
  payload: Record<string, unknown>,
  shape: (terminal: TerminalLine, log: string[]) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(config.socketPath);
    const log: string[] = [];
    let buffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      // Defensive: clearTimeout below (on a normal resolve/error) should prevent this callback from firing
      // at all once settled -- kept as a guard in case of a rare timer/event-loop race, not because it's
      // expected to trigger in practice.
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`redeploy companion did not respond within ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token: config.token, ...payload })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // a malformed line from the companion is dropped, not fatal -- the terminal line still wins
        }
        if (parsed && typeof parsed === "object" && "log" in parsed && typeof (parsed as { log: unknown }).log === "string") {
          log.push((parsed as { log: string }).log);
          continue;
        }
        if (parsed && typeof parsed === "object" && "ok" in parsed) {
          if (settled) continue;
          settled = true;
          clearTimeout(timeout);
          socket.end();
          resolve(shape(parsed as TerminalLine, log));
        }
      }
    });

    socket.on("error", (error) => {
      // Defensive only: Promise settlement is idempotent, so a late error after an earlier resolve/reject
      // would be a silent no-op even without this guard; it just skips a wasted clearTimeout/reject call,
      // not a correctness requirement.
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("redeploy companion closed the connection before sending a terminal response"));
    });
  });
}
