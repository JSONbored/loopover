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
const defaultImage = "ghcr.io/jsonbored/gittensory-selfhost:latest";

interface RunOptions {
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  dockerStatus?: string;
  timeoutSeconds?: string;
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-selfhost-image-"));
  const binDir = join(dir, "bin");
  const dockerCalls = join(dir, "docker-calls.log");
  const dockerImages = join(dir, "docker-images.log");
  const envPath = join(dir, ".env");

  mkdirSync(binDir);
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  gittensory:\n    image: old\n");
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
        grep 'image:' "$last_file" >> "$DOCKER_IMAGES"
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
  if grep -q '^GITTENSORY_IMAGE=' "$SELFHOST_ENV_FILE" 2>/dev/null; then
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

  return {
    dir,
    envPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    readCalls: () => readOptional(dockerCalls),
    readImages: () => readOptional(dockerImages),
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
      args: ["ghcr.io/jsonbored/gittensory-selfhost:cli"],
      env: { GITTENSORY_IMAGE: "ghcr.io/jsonbored/gittensory-selfhost:env" },
      envFile: "GITTENSORY_IMAGE=ghcr.io/jsonbored/gittensory-selfhost:file\n",
      expected: "ghcr.io/jsonbored/gittensory-selfhost:cli",
    },
    {
      name: "environment variable",
      env: { GITTENSORY_IMAGE: "ghcr.io/jsonbored/gittensory-selfhost:env" },
      envFile: "GITTENSORY_IMAGE=ghcr.io/jsonbored/gittensory-selfhost:file\n",
      expected: "ghcr.io/jsonbored/gittensory-selfhost:env",
    },
    {
      name: ".env value",
      envFile: "GITTENSORY_IMAGE=ghcr.io/jsonbored/gittensory-selfhost:file\n",
      expected: "ghcr.io/jsonbored/gittensory-selfhost:file",
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
      expect(readFileSync(harness.envPath, "utf8")).toContain(`GITTENSORY_IMAGE=${expected}`);
      expect(harness.readImages()).toContain(`image: "${expected}"`);
      expect(harness.readCalls()).toContain("up -d --no-build --no-deps gittensory");
      expect(harness.readCalls()).not.toContain(" build ");
    } finally {
      harness.cleanup();
    }
  });

  it("persists the image only after the service reports healthy", () => {
    const image = "ghcr.io/jsonbored/gittensory-selfhost:ordered";
    const { harness, result } = runHarness({ args: [image], envFile: "EXISTING=1\n" });
    try {
      expect(result.status, result.stderr).toBe(0);
      const calls = harness.readCalls().trim().split("\n");
      expect(calls).toContain("not-persisted-before-health");
      expect(calls).not.toContain("persisted-before-health");
      expect(readFileSync(harness.envPath, "utf8")).toContain(`GITTENSORY_IMAGE=${image}`);
    } finally {
      harness.cleanup();
    }
  });

  it("does not persist the image when health times out", () => {
    const image = "ghcr.io/jsonbored/gittensory-selfhost:bad-health";
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
});
