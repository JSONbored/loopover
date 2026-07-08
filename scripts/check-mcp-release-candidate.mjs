#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReleaseCandidateReport,
  checkTag,
  checkTarball,
  checkTokenlessPublish,
  expectedReleaseTag,
  redactSensitive,
} from "./mcp-release-candidate-core.mjs";

const PACKAGE_DIR = "packages/gittensory-mcp";
const WORKSPACE = "@jsonbored/gittensory-mcp";
const PUBLISH_WORKFLOW = ".github/workflows/npm-publish.yml";
const onWindows = process.platform === "win32";

function arg(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
  return null;
}

const wantsJson = process.argv.includes("--json");

function run(command, args, options = {}) {
  // shell:true on Windows so `npm`/`npx` (.cmd shims) resolve; output is captured, never streamed raw.
  return spawnSync(command, args, { encoding: "utf8", shell: onWindows, ...options });
}

function readMaybe(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function tarballFileCheck() {
  const result = run("npm", ["pack", "--workspace", WORKSPACE, "--dry-run", "--json"]);
  if (result.status !== 0 || !result.stdout) {
    return { check: { ok: false, code: "tarball_unsafe", message: "Could not compute the package file list via npm pack --dry-run." } };
  }
  const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  const contentsByFile = {};
  for (const file of files) {
    const full = join(PACKAGE_DIR, file);
    if (existsSync(full)) contentsByFile[file] = readFileSync(full, "utf8");
  }
  return { check: checkTarball({ files, contentsByFile }) };
}

function packedCliSmoke() {
  const build = run("npm", ["run", "build:mcp"]);
  if (build.status !== 0) {
    return { ok: false, code: "cli_smoke_failed", message: "npm run build:mcp failed before the packed CLI smoke." };
  }
  const pack = run("npm", ["pack", "--workspace", WORKSPACE, "--json"]);
  if (pack.status !== 0 || !pack.stdout) {
    return { ok: false, code: "cli_smoke_failed", message: "npm pack failed while preparing the packed CLI smoke." };
  }
  const filename = JSON.parse(pack.stdout)[0].filename;
  const tarball = join(process.cwd(), filename);
  let temp = null;
  try {
    temp = mkdtempSync(join(tmpdir(), "mcp-rc-"));
    if (run("npm", ["--prefix", temp, "init", "-y"]).status !== 0) {
      return { ok: false, code: "cli_smoke_failed", message: "Could not initialize a temp project for the packed CLI smoke." };
    }
    if (run("npm", ["--prefix", temp, "install", tarball]).status !== 0) {
      return { ok: false, code: "cli_smoke_failed", message: "Installing the packed tarball into a temp project failed." };
    }
    const binName = onWindows ? "gittensory-mcp.cmd" : "gittensory-mcp";
    const bin = join(temp, "node_modules", ".bin", binName);
    const smoke = run(bin, ["--help"]);
    if (smoke.status !== 0) {
      return { ok: false, code: "cli_smoke_failed", message: "Packed gittensory-mcp --help did not exit cleanly." };
    }
    return { ok: true, code: "cli_smoke_ok", message: "Packed gittensory-mcp --help runs cleanly from the installed tarball." };
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
}

function emit(line) {
  process.stdout.write(`${redactSensitive(line)}\n`);
}

function main() {
  const version = packageVersion();
  const tag = arg("tag") ?? (version ? expectedReleaseTag(version) : "mcp-v<version>");

  const tagCheck = { ...checkTag({ tag, packageVersion: version }), tag };
  const { check: tarball } = tarballFileCheck();
  const tokenless = checkTokenlessPublish(readMaybe(PUBLISH_WORKFLOW));
  const cliSmoke = packedCliSmoke();

  const report = buildReleaseCandidateReport({ tag: tagCheck, tarball, cliSmoke, tokenless });

  if (wantsJson) {
    process.stdout.write(`${redactSensitive(JSON.stringify(report, null, 2))}\n`);
  } else {
    emit(`MCP release-candidate dry-run for ${tag} (no publish attempted)`);
    for (const check of report.checks) emit(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.message}`);
    emit("Next steps:");
    for (const step of report.nextSteps) emit(`  - ${step}`);
    emit(report.ok ? "Release candidate is SAFE to tag." : "Release candidate is NOT safe to tag yet.");
  }

  process.exit(report.ok ? 0 : 1);
}

main();
