import { argsWantJson, reportCliFailure } from "./cli-error.js";

export function printVersion(input) {
  console.log(`${input.packageName}/${input.packageVersion} (node ${process.version})`);
}

export function printHelp(input) {
  console.log(
    [
      input.packageName,
      "",
      "Foundation CLI for the local LoopOver miner runtime.",
      "",
      "Usage:",
      "  loopover-miner --help",
      "  loopover-miner --version",
      "  loopover-miner help",
      "  loopover-miner version",
      "  loopover-miner init [--json] [--verify-token]              Bootstrap laptop-mode local SQLite state",
      "  loopover-miner init --interactive                           Guided first-run wizard: prompts for GITHUB_TOKEN + provider, writes a starter .env, then runs doctor",
      "  loopover-miner status [--json]                              Show installed versions + local state paths",
      "  loopover-miner doctor [--json]                              Check this laptop is set up correctly",
      "  loopover-miner migrate [--json]                             Apply pending schema migrations to existing local stores",
      "  loopover-miner metrics                                      Print prediction-calibration counters in Prometheus text format",
      "  loopover-miner manage status [--json]                       Show managed PR rows from local portfolio + ledger",
      "  loopover-miner manage poll <owner/repo> <pr#> [--branch <name>] [--dry-run] [--json]",
      "  loopover-miner discover <owner/repo> [<owner/repo>...] [--dry-run] [--json]",
      "  loopover-miner discover --search <query> [--dry-run] [--json]  Fan out, rank, and enqueue candidates",
      "  loopover-miner attempt <owner/repo> <issue#> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--json]",
      "  loopover-miner loop <owner/repo> [<owner/repo>...] --miner-login <login> [--base <branch>] [--live] [--dry-run]",
      "  loopover-miner loop --search <query> --miner-login <login> [--max-cycles <n>] [--cycle-delay-ms <ms>] [--dry-run] [--json]",
      "                                                                 Autonomous discover->claim->attempt->reenter loop",
      "  loopover-miner queue list [--repo <owner/repo>] [--json]    List portfolio backlog rows",
      "  loopover-miner queue next [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]",
      "                                                                 Claim the highest-priority queued item, optionally WIP-cap-aware",
      "  loopover-miner queue claim-batch [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]",
      "  loopover-miner queue metrics                                Print portfolio-queue counters in Prometheus text format",
      "  loopover-miner queue done <owner/repo> <identifier> [--dry-run] [--json]",
      "  loopover-miner queue release <owner/repo> <identifier> [--dry-run] [--json]  Return a claimed item to the queue",
      "  loopover-miner queue requeue <owner/repo> <identifier> [--dry-run] [--json]  Put a completed item back on the queue",
      "  loopover-miner claim claim <owner/repo> <issue#> [--note <text>] [--dry-run] [--json]",
      "  loopover-miner claim release <owner/repo> <issue#> [--dry-run] [--json]",
      "  loopover-miner claim list [--repo <owner/repo>] [--status active|released|expired] [--json]",
      "  loopover-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]",
      "  loopover-miner ledger metrics                               Print event-ledger counters in Prometheus text format",
      "  loopover-miner plan list [--status pending|running|completed|failed] [--json]",
      "  loopover-miner plan show <planId> [--json]",
      "  loopover-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]",
      "  loopover-miner governor pause [--reason <text>] [--dry-run] [--json]  Stop the loop before its next cycle",
      "  loopover-miner governor resume [--dry-run] [--json]         Let a paused loop continue",
      "  loopover-miner governor status [--json]                     Show whether the governor is paused",
      "  loopover-miner governor metrics                              Print governor rate-limit/cap-usage counters in Prometheus text format",
      "  loopover-miner calibration [--json]                         Report predicted-vs-realized gate accuracy",
      "  loopover-miner feasibility <claimStatus> <duplicateClusterRisk> <issueStatus> [--not-found] [--json]",
      "  loopover-miner hooks check --tool <name> --input <json> [--json]",
      "  loopover-miner state get <owner/repo> [--json]",
      "  loopover-miner state set <owner/repo> <idle|discovering|planning|preparing> [--dry-run] [--json]",
      "  loopover-miner orb export [--enable] [--send] [--dry-run] [--json]   Build (and optionally send) the opt-in anonymized telemetry batch",
      "  loopover-miner purge --repo <owner/repo> [--dry-run] [--json]",
      "                                                                 Right-to-be-forgotten: delete a repo's rows from every local store",
      "",
      "Options:",
      "  --no-update-check  Skip the npm registry version nudge (also LOOPOVER_MINER_NO_UPDATE_CHECK=1)",
      "  --quiet            Log only warnings and errors (also LOOPOVER_MINER_LOG_LEVEL=error)",
      "  --verbose          Log debug-level diagnostics (also LOOPOVER_MINER_LOG_LEVEL=debug)",
      "  --log-level <lvl>  Set the log level explicitly: silent|error|warn|info|debug",
    ].join("\n"),
  );
}

export function runCli(cliArgs, input) {
  const command = cliArgs[0] ?? "";
  const message = `Unknown command: ${command}. Run ${input.packageName} --help.`;
  return reportCliFailure(argsWantJson(cliArgs), message, 1);
}
