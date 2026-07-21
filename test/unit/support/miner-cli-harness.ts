import { Buffer } from "node:buffer";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ForgeFixtureRepo = {
  owner: string;
  repo: string;
  issues?: Array<Record<string, unknown>>;
  contributingContent?: string;
};

export type CliProcessResult = {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
};

// packages/loopover-miner ships .ts source only (no committed compiled output -- Vite/esbuild already
// resolves .js-suffixed import specifiers to the sibling .ts by default, which is why in-process imports
// never needed anything special either). Spawning the real CLI as a subprocess still needs a real runnable
// entrypoint, so this runs the .ts directly via Node's own built-in type-stripping (--experimental-strip-
// types, explicit rather than relying on its default-on state so this keeps working regardless of exactly
// which supported Node 22.x patch is running) instead of requiring a prior `npm run build:miner`. Type
// STRIPPING, not full transformation or type-checking -- that's fine here since `npm run typecheck`/
// `build:miner` elsewhere in the gate already own type-correctness, and neither bin/lib file uses syntax
// erasable-only stripping can't handle (enums, namespaces, constructor parameter properties): this harness
// only needs the CLI to actually run. process.execPath (not a bare "node") mirrors scripts/check-syntax.mjs's
// own convention -- guarantees the exact Node binary already running the test, not whatever "node" resolves
// to on PATH.
const NODE_STRIP_TYPES_ARGS = ["--experimental-strip-types"];
export const bin = join(
  process.cwd(),
  "packages/loopover-miner/bin/loopover-miner.ts",
);
let server: Server | null = null;

export async function closeFixtureServer() {
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
}

export function run(args: string[], env: Record<string, string> = {}) {
  return execFileSync(process.execPath, [...NODE_STRIP_TYPES_ARGS, bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runCapture(args: string[], env: Record<string, string> = {}) {
  return runCliResult(args, env).output;
}

export function runCliResult(
  args: string[],
  env: Record<string, string> = {},
): CliProcessResult {
  const result = spawnSync(process.execPath, [...NODE_STRIP_TYPES_ARGS, bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

export function runAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<CliProcessResult>((resolve) => {
    execFile(
      process.execPath,
      [...NODE_STRIP_TYPES_ARGS, bin, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
        },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const outStdout = stdout ?? "";
        const outStderr = stderr ?? "";
        resolve({
          status:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          stdout: outStdout,
          stderr: outStderr,
          output: `${outStdout}${outStderr}`,
        });
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
      if (request.url && request.url.includes("loopover%2Fminer/latest")) {
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
  return mkdtempSync(join(tmpdir(), "loopover-miner-cli-"));
}

function defaultForgeIssue(number: number, owner: string, repo: string) {
  return {
    number,
    title: `E2E fixture issue ${number}`,
    labels: [{ name: "help wanted" }],
    comments: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T01:00:00Z",
    html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
  };
}

function encodeRepoDoc(content: string) {
  return JSON.stringify({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  });
}

function resolveForgeRepo(
  repos: ForgeFixtureRepo[],
  owner: string,
  repo: string,
): ForgeFixtureRepo {
  const key = `${owner}/${repo}`.toLowerCase();
  const configured = repos.find(
    (entry) => `${entry.owner}/${entry.repo}`.toLowerCase() === key,
  );
  if (configured) return configured;
  return {
    owner,
    repo,
    issues: [defaultForgeIssue(42, owner, repo)],
    contributingContent: "Contributions welcome.",
  };
}

/** Minimal GitHub-compatible forge HTTP fixture for true CLI discover runs (#4869). */
export async function startForgeFixture(repos: ForgeFixtureRepo[] = []) {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);

    const contentsMatch = pathname.match(
      /^\/repos\/([^/]+)\/([^/]+)\/contents\/([^/]+)$/,
    );
    if (contentsMatch) {
      const owner = contentsMatch[1];
      const repo = contentsMatch[2];
      const docName = contentsMatch[3];
      if (!owner || !repo || !docName) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      const repoConfig = resolveForgeRepo(repos, owner, repo);
      response.setHeader("content-type", "application/json");
      if (docName === "AI-USAGE.md") {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      if (docName === "CONTRIBUTING.md") {
        response.statusCode = 200;
        response.end(
          encodeRepoDoc(repoConfig.contributingContent ?? "Contributions welcome."),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
      return;
    }

    const issuesMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
    if (issuesMatch) {
      const owner = issuesMatch[1];
      const repo = issuesMatch[2];
      if (!owner || !repo) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      const repoConfig = resolveForgeRepo(repos, owner, repo);
      response.setHeader("content-type", "application/json");
      response.setHeader("x-ratelimit-remaining", "4999");
      response.setHeader("x-ratelimit-reset", "1893456000");
      response.statusCode = 200;
      response.end(JSON.stringify(repoConfig.issues ?? []));
      return;
    }

    if (pathname === "/search/issues") {
      const repoConfig = repos[0] ?? {
        owner: "acme",
        repo: "widgets",
        issues: [defaultForgeIssue(21, "acme", "widgets")],
        contributingContent: "Contributions welcome.",
      };
      const issue = (repoConfig.issues ?? [defaultForgeIssue(21, repoConfig.owner, repoConfig.repo)])[0];
      response.setHeader("content-type", "application/json");
      response.setHeader("x-ratelimit-remaining", "4999");
      response.setHeader("x-ratelimit-reset", "1893456000");
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          items: [
            {
              ...issue,
              repository: {
                full_name: `${repoConfig.owner}/${repoConfig.repo}`,
              },
            },
          ],
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: "not_found", path: pathname }));
  });
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("forge fixture server failed to bind");
  return `http://127.0.0.1:${address.port}`;
}
