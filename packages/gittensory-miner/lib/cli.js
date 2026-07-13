import { argsWantJson, reportCliFailure } from "./cli-error.js";

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
      "  gittensory-miner init [--json] [--verify-token]              Bootstrap laptop-mode local SQLite state",
      "  gittensory-miner status [--json]                              Show installed versions + local state paths",
      "  gittensory-miner doctor [--json]                              Check this laptop is set up correctly",
      "  gittensory-miner migrate [--json]                             Apply pending schema migrations to existing local stores",
      "  gittensory-miner metrics                                      Print prediction-calibration counters in Prometheus text format",
      "  gittensory-miner manage status [--json]                       Show managed PR rows from local portfolio + ledger",
      "  gittensory-miner manage poll <owner/repo> <pr#> [--branch <name>] [--json]",
      "  gittensory-miner discover <owner/repo> [<owner/repo>...] [--json]",
      "  gittensory-miner discover --search <query> [--json]           Fan out, rank, and enqueue candidates",
      "  gittensory-miner attempt <owner/repo> <issue#> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--json]",
      "  gittensory-miner loop <owner/repo> [<owner/repo>...] --miner-login <login> [--base <branch>] [--live] [--dry-run]",
      "  gittensory-miner loop --search <query> --miner-login <login> [--max-cycles <n>] [--cycle-delay-ms <ms>] [--dry-run] [--json]",
      "                                                                 Autonomous discover->claim->attempt->reenter loop",
      "  gittensory-miner queue list [--repo <owner/repo>] [--json]    List portfolio backlog rows",
      "  gittensory-miner queue next [--json]                          Claim the highest-priority queued item",
      "  gittensory-miner queue claim-batch [--global-wip <n>] [--per-repo-wip <n>] [--json]",
      "  gittensory-miner queue done <owner/repo> <identifier> [--json]",
      "  gittensory-miner queue release <owner/repo> <identifier> [--json]  Return a claimed item to the queue",
      "  gittensory-miner queue requeue <owner/repo> <identifier> [--json]  Put a completed item back on the queue",
      "  gittensory-miner claim claim <owner/repo> <issue#> [--note <text>] [--json]",
      "  gittensory-miner claim release <owner/repo> <issue#> [--json]",
      "  gittensory-miner claim list [--repo <owner/repo>] [--status active|released|expired] [--json]",
      "  gittensory-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]",
      "  gittensory-miner ledger metrics                               Print event-ledger counters in Prometheus text format",
      "  gittensory-miner plan list [--status pending|running|completed|failed] [--json]",
      "  gittensory-miner plan show <planId> [--json]",
      "  gittensory-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]",
      "  gittensory-miner calibration [--json]                         Report predicted-vs-realized gate accuracy",
      "  gittensory-miner feasibility <claimStatus> <duplicateClusterRisk> <issueStatus> [--not-found] [--json]",
      "  gittensory-miner hooks check --tool <name> --input <json> [--json]",
      "  gittensory-miner state get <owner/repo> [--json]",
      "  gittensory-miner state set <owner/repo> <idle|discovering|planning|preparing> [--json]",
      "  gittensory-miner orb export [--enable] [--json]               Build the opt-in anonymized telemetry batch",
      "",
      "Options:",
      "  --no-update-check  Skip the npm registry version nudge (also GITTENSORY_MINER_NO_UPDATE_CHECK=1)",
      "  --quiet            Log only warnings and errors (also GITTENSORY_MINER_LOG_LEVEL=error)",
      "  --verbose          Log debug-level diagnostics (also GITTENSORY_MINER_LOG_LEVEL=debug)",
      "  --log-level <lvl>  Set the log level explicitly: silent|error|warn|info|debug",
    ].join("\n"),
  );
}

export function runCli(cliArgs, input) {
  const command = cliArgs[0] ?? "";
  const message = `Unknown command: ${command}. Run ${input.packageName} --help.`;
  return reportCliFailure(argsWantJson(cliArgs), message, 1);
}
