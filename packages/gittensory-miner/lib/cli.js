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
      "  gittensory-miner ci wait <owner/repo> <pr-number> [--json] [--max-attempts N] [--min-interval-ms N] [--max-interval-ms N]",
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
