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
      "  gittensory-miner status [--json]                              Show installed versions + local state paths",
      "  gittensory-miner doctor [--json]                              Check this laptop is set up correctly",
      "  gittensory-miner manage status [--json]                       Show managed PR rows from local portfolio + ledger",
      "  gittensory-miner queue list [--repo <owner/repo>] [--json]    List portfolio backlog rows",
      "  gittensory-miner queue next [--json]                          Claim the highest-priority queued item",
      "  gittensory-miner queue done <owner/repo> <identifier> [--json]",
      "  gittensory-miner hooks check --tool <name> --input <json> [--json]",
      "  gittensory-miner state get <owner/repo> [--json]",
      "  gittensory-miner state set <owner/repo> <idle|discovering|planning|preparing> [--json]",
      "",
      "Options:",
      "  --no-update-check  Skip the npm registry version nudge (also GITTENSORY_MINER_NO_UPDATE_CHECK=1)",
    ].join("\n"),
  );
}

export function runCli(cliArgs, input) {
  const command = cliArgs[0] ?? "";
  console.error(`Unknown command: ${command}. Run ${input.packageName} --help.`);
  return 1;
}
