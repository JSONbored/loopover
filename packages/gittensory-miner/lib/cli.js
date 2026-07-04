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
      "  gittensory-miner manage poll <owner/repo> <pr#> [--branch <name>] [--json]",
      "  gittensory-miner queue list [--repo <owner/repo>] [--json]    List portfolio backlog rows",
      "  gittensory-miner queue next [--json]                          Claim the highest-priority queued item",
      "  gittensory-miner queue done <owner/repo> <identifier> [--json]",
      "  gittensory-miner claims list [--repo <owner/repo>] [--status active|released|expired] [--json]",
      "  gittensory-miner claims claim <owner/repo> <issue#> [--note <text>] [--json]",
      "  gittensory-miner claims release <owner/repo> <issue#> [--json]",
      "  gittensory-miner claims sweep [--max-age-days <n>] [--json]",
      "  gittensory-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]",
      "  gittensory-miner plan list [--status pending|running|completed|failed] [--json]",
      "  gittensory-miner plan show <planId> [--json]",
      "  gittensory-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]",
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
