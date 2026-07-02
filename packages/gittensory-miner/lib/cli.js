import { accessSync, constants, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const defaultStateFileName = "state.sqlite3";

export function printVersion(input) {
  console.log(`${input.packageName}/${input.packageVersion} (node ${process.version})`);
}

export function printHelp(input) {
  console.log(
    [
      input.packageName,
      "",
      "Foundation CLI for the local Gittensory miner runtime.",
      "",
      "Usage:",
      "  gittensory-miner --help",
      "  gittensory-miner --version",
      "  gittensory-miner help",
      "  gittensory-miner version",
      "  gittensory-miner init",
      "  gittensory-miner doctor",
      "  gittensory-miner doctor --json",
      "",
      "Options:",
      "  --no-update-check  Skip the npm registry version nudge (also GITTENSORY_MINER_NO_UPDATE_CHECK=1)",
    ].join("\n"),
  );
}

export function resolveMinerConfigDir(env = process.env) {
  if (env.GITTENSORY_MINER_CONFIG_DIR) return env.GITTENSORY_MINER_CONFIG_DIR;
  const xdgConfigHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdgConfigHome, "gittensory-miner");
}

export function resolveMinerStatePath(env = process.env) {
  return join(resolveMinerConfigDir(env), defaultStateFileName);
}

export function initMinerState(env = process.env) {
  const configDir = resolveMinerConfigDir(env);
  const statePath = resolveMinerStatePath(env);
  const createdConfigDir = !existsSync(configDir);
  mkdirSync(configDir, { recursive: true });
  const createdStateFile = !existsSync(statePath);
  if (createdStateFile) {
    const fd = openSync(statePath, "w");
    closeSync(fd);
  }
  return { configDir, statePath, createdConfigDir, createdStateFile };
}

export function inspectDoctor(env = process.env) {
  const configDir = resolveMinerConfigDir(env);
  const statePath = resolveMinerStatePath(env);
  const stateExists = existsSync(statePath);
  let stateWritable = false;
  if (stateExists) {
    try {
      accessSync(statePath, constants.W_OK);
      stateWritable = true;
    } catch {
      stateWritable = false;
    }
  }

  const dockerProbe = spawnSync("docker", ["--version"], {
    encoding: "utf8",
    timeout: 2000,
  });

  const dockerPresent = dockerProbe.status === 0 && !dockerProbe.error;
  return {
    nodeVersion: process.version,
    configDir,
    statePath,
    stateExists,
    stateWritable,
    dockerPresent,
  };
}

export function runCli(cliArgs, input) {
  const command = cliArgs[0] ?? "";
  if (command === "init") {
    const initialized = initMinerState();
    console.log(`config_dir=${initialized.configDir}`);
    console.log(`state_file=${initialized.statePath}`);
    console.log(
      initialized.createdStateFile
        ? "state initialized (created)"
        : "state initialized (already exists)",
    );
    return 0;
  }
  if (command === "doctor") {
    const report = inspectDoctor();
    const asJson = cliArgs.includes("--json");
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`node=${report.nodeVersion}`);
      console.log(`config_dir=${report.configDir}`);
      console.log(`state_file=${report.statePath}`);
      console.log(`state_exists=${report.stateExists}`);
      console.log(`state_writable=${report.stateWritable}`);
      console.log(`docker_present=${report.dockerPresent}`);
    }
    return 0;
  }
  console.error(`Unknown command: ${command}. Run ${input.packageName} --help.`);
  return 1;
}
