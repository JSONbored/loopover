import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const bin = join(
  process.cwd(),
  "packages/gittensory-miner/bin/gittensory-miner.js",
);
let server: Server | null = null;

export async function closeFixtureServer() {
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
}

export function run(args: string[], env: Record<string, string> = {}) {
  return execFileSync("node", [bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runCapture(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("node", [bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function runAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      "node",
      [bin, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function startRegistryFixture(
  options: {
    latestVersion?: string;
    npmStatus?: number;
    delayMs?: number;
  } = {},
) {
  server = createServer((request, response) => {
    const respond = () => {
      response.setHeader("content-type", "application/json");
      if (request.url && request.url.includes("gittensory-miner/latest")) {
        if (options.npmStatus && options.npmStatus >= 400) {
          response.statusCode = options.npmStatus;
          response.end(JSON.stringify({ error: "registry_error" }));
          return;
        }
        response.end(
          JSON.stringify({ version: options.latestVersion ?? "0.1.0" }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    };
    if (options.delayMs && options.delayMs > 0) {
      setTimeout(respond, options.delayMs);
      return;
    }
    respond();
  });
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture server failed to bind");
  return `http://127.0.0.1:${address.port}`;
}

export function tempEnvPrefix() {
  return mkdtempSync(join(tmpdir(), "gittensory-miner-cli-"));
}
