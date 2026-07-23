import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/deploy-selfhost-image.sh");
const defaultImage = "ghcr.io/jsonbored/loopover-selfhost:latest";
// #4777: publishing under the pre-rename name has stopped, but GHCR has no server-side alias, so its
// already-published tags/digests keep resolving forever -- an operator who pinned it explicitly (CLI
// arg, env var, or .env value) must keep resolving to that exact string unmodified, even though
// DEFAULT_IMAGE above now points at the new name.
const legacyPinnedImage = "ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0";

interface RunOptions {
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  dockerStatus?: string;
  timeoutSeconds?: string;
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "loopover-selfhost-image-"));
  const binDir = join(dir, "bin");
  const dockerCalls = join(dir, "docker-calls.log");
  const dockerImages = join(dir, "docker-images.log");
  const infisicalCalls = join(dir, "infisical-calls.log");
  const envPath = join(dir, ".env");

  mkdirSync(binDir);
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  loopover:\n    image: old\n");
  writeFileSync(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_CALLS"

if [ "$1" = "compose" ]; then
  case "$*" in
    *" pull --policy always "*)
      last_file=""
      prev=""
      for arg in "$@"; do
        if [ "$prev" = "-f" ]; then
          last_file="$arg"
        fi
        prev="$arg"
      done
      if [ -n "$last_file" ]; then
        cat "$last_file" >> "$DOCKER_IMAGES"
      fi
      exit 0
      ;;
    *" version"*|*" up -d --no-build --no-deps "*|*" ps "*|*" logs "*)
      if [[ "$*" == *" ps -q "* ]]; then
        printf 'container-id\\n'
      fi
      exit 0
      ;;
  esac
fi

if [ "$1" = "inspect" ]; then
  if grep -q '^LOOPOVER_IMAGE=' "$SELFHOST_ENV_FILE" 2>/dev/null; then
    printf '%s\\n' persisted-before-health >> "$DOCKER_CALLS"
  else
    printf '%s\\n' not-persisted-before-health >> "$DOCKER_CALLS"
  fi
  printf '%s\\n' "\${DOCKER_INSPECT_STATUS:-healthy}"
  exit 0
fi

printf 'unexpected docker invocation: %s\\n' "$*" >&2
exit 1
`,
  );
  chmodSync(join(binDir, "docker"), 0o755);

  function writeFakeInfisical() {
    writeFileSync(
      join(binDir, "infisical"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$INFISICAL_CALLS"
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
`,
    );
    chmodSync(join(binDir, "infisical"), 0o755);
  }

  return {
    dir,
    envPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    readCalls: () => readOptional(dockerCalls),
    readImages: () => readOptional(dockerImages),
    readInfisicalCalls: () => readOptional(infisicalCalls),
    writeFakeInfisical,
    run(options: RunOptions = {}) {
      if (options.envFile !== undefined) writeFileSync(envPath, options.envFile);
      const result = spawnSync("bash", [scriptPath, ...(options.args ?? [])], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SELFHOST_ENV_FILE: envPath,
          SELFHOST_HEALTH_TIMEOUT_SECONDS: options.timeoutSeconds ?? "10",
          DOCKER_CALLS: dockerCalls,
          DOCKER_IMAGES: dockerImages,
          DOCKER_INSPECT_STATUS: options.dockerStatus ?? "healthy",
          INFISICAL_CALLS: infisicalCalls,
          ...(options.env ?? {}),
        },
      });
      return result;
    },
  };
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function runHarness(options: RunOptions = {}) {
  const harness = createHarness();
  const result = harness.run(options);
  return { harness, result };
}

describe("self-host image deploy script", () => {
  it.each([
    {
      name: "CLI argument",
      args: ["ghcr.io/jsonbored/loopover-selfhost:cli"],
      env: { LOOPOVER_IMAGE: "ghcr.io/jsonbored/loopover-selfhost:env" },
      envFile: "LOOPOVER_IMAGE=ghcr.io/jsonbored/loopover-selfhost:file\n",
      expected: "ghcr.io/jsonbored/loopover-selfhost:cli",
    },
    {
      name: "environment variable",
      env: { LOOPOVER_IMAGE: "ghcr.io/jsonbored/loopover-selfhost:env" },
      envFile: "LOOPOVER_IMAGE=ghcr.io/jsonbored/loopover-selfhost:file\n",
      expected: "ghcr.io/jsonbored/loopover-selfhost:env",
    },
    {
      name: ".env value",
      envFile: "LOOPOVER_IMAGE=ghcr.io/jsonbored/loopover-selfhost:file\n",
      expected: "ghcr.io/jsonbored/loopover-selfhost:file",
    },
    {
      name: "default image",
      expected: defaultImage,
    },
  ])("uses image precedence from $name", ({ args, env, envFile, expected }) => {
    const options: RunOptions = {};
    if (args) options.args = args;
    if (env) options.env = env;
    if (envFile !== undefined) options.envFile = envFile;
    const { harness, result } = runHarness(options);
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(harness.envPath, "utf8")).toContain(`LOOPOVER_IMAGE=${expected}`);
      expect(harness.readImages()).toContain(`image: "${expected}"`);
      // REGRESSION: without this reset, an operator's own docker-compose.override.yml build: block for this
      // service silently wins over the pulled image at `up --no-build` time (found deploying live).
      expect(harness.readImages()).toContain("build: !reset null");
      expect(harness.readCalls()).toContain("up -d --no-build --no-deps loopover");
      expect(harness.readCalls()).not.toContain(" build ");
    } finally {
      harness.cleanup();
    }
  });

  // REGRESSION (#4777): DEFAULT_IMAGE moved to the new "loopover-selfhost" name, but a self-hoster who
  // explicitly pinned the pre-rename "loopover-selfhost" image (as a CLI argument, LOOPOVER_IMAGE env
  // var, or .env value) must keep resolving to that exact string, unmodified -- GHCR keeps already-published
  // tags/digests resolving forever with no server-side alias needed, and this script must not rewrite an
  // operator's existing pin either way.
  it("passes an explicit pre-rename image reference through unchanged despite the new default", () => {
    const { harness, result } = runHarness({ args: [legacyPinnedImage] });
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(harness.envPath, "utf8")).toContain(`LOOPOVER_IMAGE=${legacyPinnedImage}`);
      expect(harness.readImages()).toContain(`image: "${legacyPinnedImage}"`);
    } finally {
      harness.cleanup();
    }
  });

  it("persists the image only after the service reports healthy", () => {
    const image = "ghcr.io/jsonbored/loopover-selfhost:ordered";
    const { harness, result } = runHarness({ args: [image], envFile: "EXISTING=1\n" });
    try {
      expect(result.status, result.stderr).toBe(0);
      const calls = harness.readCalls().trim().split("\n");
      expect(calls).toContain("not-persisted-before-health");
      expect(calls).not.toContain("persisted-before-health");
      expect(readFileSync(harness.envPath, "utf8")).toContain(`LOOPOVER_IMAGE=${image}`);
    } finally {
      harness.cleanup();
    }
  });

  it("does not persist the image when health times out", () => {
    const image = "ghcr.io/jsonbored/loopover-selfhost:bad-health";
    const { harness, result } = runHarness({
      args: [image],
      envFile: "EXISTING=1\n",
      dockerStatus: "starting",
      timeoutSeconds: "0",
    });
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("did not become healthy within 0s");
      expect(readFileSync(harness.envPath, "utf8")).toBe("EXISTING=1\n");
      expect(harness.readImages()).toContain(`image: "${image}"`);
      expect(harness.readCalls()).not.toContain(" build ");
    } finally {
      harness.cleanup();
    }
  });

  it.each([
    "registry.example/loopover:${GITHUB_OAUTH_CLIENT_SECRET}",
    "registry.example/loopover:$GITHUB_OAUTH_CLIENT_SECRET",
    "registry.example/loopover:{GITHUB_OAUTH_CLIENT_SECRET}",
  ])("rejects compose interpolation characters in image %s", (image) => {
    const { harness, result } = runHarness({ args: [image], envFile: "EXISTING=1\n" });
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "image contains unsupported whitespace, quote, backslash, compose interpolation, or shell metacharacters",
      );
      expect(readFileSync(harness.envPath, "utf8")).toBe("EXISTING=1\n");
      expect(harness.readImages()).toBe("");
      expect(harness.readCalls()).not.toContain(" pull ");
    } finally {
      harness.cleanup();
    }
  });

  // Defense-in-depth, not a currently-reachable code-execution path: every reference to the resolved image
  // value downstream (resolve_image's printf, this heredoc's "$IMAGE") is properly quoted, so a backtick or
  // other shell metacharacter arriving as a real argv element (never through a shell -- see
  // redeploy-companion.ts's own spawn() call, which never sets shell: true) stays inert literal text all the
  // way through. Rejecting these anyway costs nothing (no legitimate image reference ever contains them) and
  // guards against any future change to this script -- or a caller of it -- that stops quoting consistently.
  it.each([
    "registry.example/loopover:`touch /tmp/pwned`",
    "registry.example/loopover:latest;rm -rf /",
    "registry.example/loopover:latest|cat /etc/passwd",
    "registry.example/loopover:latest&&whoami",
    "registry.example/loopover:latest>/tmp/pwned",
    "registry.example/loopover:latest</etc/passwd",
  ])("rejects shell metacharacters in image %s", (image) => {
    const { harness, result } = runHarness({ args: [image], envFile: "EXISTING=1\n" });
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "image contains unsupported whitespace, quote, backslash, compose interpolation, or shell metacharacters",
      );
      expect(readFileSync(harness.envPath, "utf8")).toBe("EXISTING=1\n");
      expect(harness.readImages()).toBe("");
      expect(harness.readCalls()).not.toContain(" pull ");
    } finally {
      harness.cleanup();
    }
  });

  describe("optional Infisical wrapper (#5120)", () => {
    it("does not invoke infisical by default -- the restart step runs docker compose directly", () => {
      const { harness, result } = runHarness();
      try {
        expect(result.status, result.stderr).toBe(0);
        expect(harness.readCalls()).toContain("up -d --no-build --no-deps loopover");
        expect(harness.readInfisicalCalls()).toBe("");
      } finally {
        harness.cleanup();
      }
    });

    it("wraps only the restart (up) step with `infisical run --` when SELFHOST_USE_INFISICAL=1", () => {
      const harness = createHarness();
      harness.writeFakeInfisical();
      try {
        const result = harness.run({ env: { SELFHOST_USE_INFISICAL: "1" } });
        expect(result.status, result.stderr).toBe(0);
        // The real docker compose invocation still happened (infisical's fake execs through to it)...
        expect(harness.readCalls()).toContain("up -d --no-build --no-deps loopover");
        // ...but only the restart step went through infisical -- pull is a plain image fetch, not a process
        // launch that needs injected secrets, so it must NOT be wrapped.
        const infisicalCalls = harness.readInfisicalCalls();
        expect(infisicalCalls).toContain("run -- docker compose");
        expect(infisicalCalls).toContain("up -d --no-build --no-deps loopover");
        expect(infisicalCalls).not.toContain("pull --policy always");
      } finally {
        harness.cleanup();
      }
    });

    it("fails closed with a clear error when SELFHOST_USE_INFISICAL=1 but infisical is not installed", () => {
      const { harness, result } = runHarness({ env: { SELFHOST_USE_INFISICAL: "1" } });
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("required command not found: infisical");
      } finally {
        harness.cleanup();
      }
    });
  });
});
