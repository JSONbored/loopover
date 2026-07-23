#!/usr/bin/env node
// Host-side redeploy companion (#7723, sub-issue of #7720): a narrow, purpose-built listener that lets the
// `loopover` app container trigger a real redeploy of itself WITHOUT ever mounting /var/run/docker.sock into
// an app-facing container -- this repo's own docker-proxy service (docker-compose.yml) already documents why
// that's unacceptable ("a :ro socket bind-mount only protects the socket inode, it does NOT restrict the
// Docker API... effectively host root"), and review-enrichment/src/analyzers/iac-misconfig.ts flags exactly
// this pattern as an IaC misconfiguration finding in the PRs this bot reviews for everyone else.
//
// DESIGN, chosen over extending docker-proxy (tecnativa/docker-socket-proxy): that image's ACL model is
// "which API section/verb is enabled globally," with no way to scope a restart to ONE named container -- the
// best it offers is "restart-only, for any container reachable through the socket," broader than intended.
// Worse, the real desired behavior (pull a new image, recreate the container, wait for health) is
// docker-compose-level orchestration, not a single Docker Engine API call a raw proxy could cleanly
// allowlist. This companion instead runs entirely OUTSIDE Docker (a systemd service on the host) and calls
// through the EXACT existing, already-tested scripts/deploy-selfhost-image.sh -- not a reimplementation of
// its pull+recreate+health-wait sequence.
//
// PROTOCOL: listens on a Unix domain socket, NOT a TCP port -- reachable only via a filesystem path, which is
// what gets bind-mounted (read-write) into the `loopover` container at the SAME path, rather than opening any
// network-level attack surface. One line-delimited JSON request per connection:
//   {"token": "<REDEPLOY_COMPANION_TOKEN>", "image"?: "<optional pinned image>"}
// The token is a SEPARATE credential from LOOPOVER_MCP_ADMIN_TOKEN (defense in depth: the MCP-layer gate in
// src/mcp/server.ts is the first check, this is the second, independent one on the host side -- a bug or
// misconfiguration in one layer doesn't strand the other). Streams `{"log": "..."}` lines for each line of the
// real script's stdout/stderr, then exactly one terminal `{"ok": true, "exitCode": 0}` or
// `{"ok": false, "exitCode": N, "error"?: "..."}`, and closes the connection.
//
// CONCURRENCY: rejects a second redeploy request while one is already running (`{"ok": false, "error":
// "redeploy_already_in_progress"}`) -- two concurrent `docker compose pull && up -d` calls against the same
// service is a real race (image tag resolution, container recreation), not just wasted work.
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { unlinkSync, chmodSync, existsSync } from "node:fs";

const SOCKET_PATH = process.env.REDEPLOY_COMPANION_SOCKET_PATH?.trim() || "/run/loopover-redeploy.sock";
const REPO_ROOT = process.env.REDEPLOY_COMPANION_REPO_ROOT?.trim() || process.cwd();
const MAX_REQUEST_BYTES = 4096;

function requireToken(): string {
  const token = process.env.REDEPLOY_COMPANION_TOKEN?.trim();
  if (!token) {
    console.error(JSON.stringify({ level: "error", event: "redeploy_companion_missing_token" }));
    process.exit(1);
  }
  return token;
}

/** Constant-time comparison against the configured token -- a plain `===` would leak timing info about how
 *  many leading characters matched, letting an attacker on the same host incrementally guess the token. */
function isValidToken(configuredToken: string, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const configured = Buffer.from(configuredToken, "utf8");
  const supplied = Buffer.from(candidate, "utf8");
  if (configured.length !== supplied.length) return false;
  return timingSafeEqual(configured, supplied);
}

type RedeployRequest = { token: unknown; image?: unknown };

function parseRequestLine(line: string): RedeployRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as RedeployRequest;
}

/** Same character class deploy-selfhost-image.sh's own `validate_inputs` enforces -- this is a second,
 *  independent guard on the value before it ever reaches that script, giving a caller a clear MCP-level
 *  rejection instead of an opaque host-side one. Not load-bearing against code execution on its own: `spawn`
 *  below never sets `shell: true`, so the image string always reaches deploy-selfhost-image.sh as a single,
 *  literal argv element regardless of its contents, and that script only ever references it through properly
 *  quoted expansions ("$1", "$IMAGE") -- confirmed empirically, not just by inspection: none of these
 *  characters are exploitable via the current call path. Rejected anyway because no legitimate Docker image
 *  reference ever needs whitespace, quotes, `$`/`{`/`}` (compose interpolation), or shell metacharacters like
 *  backticks/`;`/`|`/`&`/`<`/`>` -- costs nothing today and guards against either side of this call ever
 *  losing that quoting discipline later. */
function isSafeImageOverride(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s"'\\${}`;|&<>]/.test(value);
}

export type RunDeployResult = { ok: boolean; exitCode: number | null; error?: string };

/** Runs the real, existing deploy-selfhost-image.sh -- never reimplemented here. Injectable spawn function for
 *  tests only; production always uses the real node:child_process.spawn. */
export function runDeploy(
  image: string | undefined,
  onLog: (line: string) => void,
  spawnImpl: typeof spawn = spawn,
): Promise<RunDeployResult> {
  return new Promise((resolve) => {
    const args = image ? [image] : [];
    const child = spawnImpl("bash", ["scripts/deploy-selfhost-image.sh", ...args], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const forwardLines = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) onLog(line);
      }
    };
    child.stdout?.on("data", forwardLines);
    child.stderr?.on("data", forwardLines);
    child.on("error", (error) => resolve({ ok: false, exitCode: null, error: error.message }));
    child.on("close", (exitCode) => resolve({ ok: exitCode === 0, exitCode }));
  });
}

/** One socket connection's full request/response lifecycle. Exported for direct unit testing without a real
 *  socket. `isBusy`/`setBusy` are the shared in-progress flag across every connection the server accepts. */
export async function handleConnection(
  configuredToken: string,
  requestLine: string,
  isBusy: () => boolean,
  setBusy: (busy: boolean) => void,
  write: (line: string) => void,
  deploy: typeof runDeploy = runDeploy,
): Promise<void> {
  const request = parseRequestLine(requestLine);
  if (!request || !isValidToken(configuredToken, request.token)) {
    write(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  if (isBusy()) {
    write(JSON.stringify({ ok: false, error: "redeploy_already_in_progress" }));
    return;
  }
  const image = isSafeImageOverride(request.image) ? request.image : undefined;
  if (request.image !== undefined && image === undefined) {
    write(JSON.stringify({ ok: false, error: "invalid_image_override" }));
    return;
  }

  setBusy(true);
  try {
    const result = await deploy(image, (line) => write(JSON.stringify({ log: line })));
    write(JSON.stringify(result.error ? { ok: result.ok, exitCode: result.exitCode, error: result.error } : { ok: result.ok, exitCode: result.exitCode }));
  } finally {
    setBusy(false);
  }
}

function main(): void {
  const configuredToken = requireToken();
  let busy = false;

  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); // a stale socket from an unclean prior shutdown

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: "request_too_large" })}\n`);
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      void handleConnection(
        configuredToken,
        line,
        () => busy,
        (value) => {
          busy = value;
        },
        (out) => socket.write(`${out}\n`),
      ).finally(() => socket.end());
    });
    socket.on("error", () => undefined); // a client disconnecting mid-request is not this process's problem
  });

  server.listen(SOCKET_PATH, () => {
    chmodSync(SOCKET_PATH, 0o660); // owner+group only -- see the systemd unit's Group= for who that is
    console.log(JSON.stringify({ level: "info", event: "redeploy_companion_listening", socketPath: SOCKET_PATH }));
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
