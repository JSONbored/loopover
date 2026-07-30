import { describe, expect, it } from "vitest";
import { run } from "./support/mcp-cli-harness";

// #6991: printHelp() listed ~30 real top-level commands but omitted two dispatched ones: `maintain`
// (packages/loopover-mcp/dist/bin/loopover-mcp.js's maintainCli) and `contributor-profile`
// (contributorProfileCli, added by #6737). A user running `loopover-mcp --help` had no way to
// discover either command exists.
describe("loopover-mcp --help lists every real top-level command (#6991)", () => {
  it("lists maintain, pointing to its own --help for the full subcommand list", () => {
    const output = run(["--help"]);
    expect(output).toMatch(/loopover-mcp maintain .*--repo owner\/repo/);
    expect(output).toMatch(/loopover-mcp maintain --help/);
  });

  it("lists contributor-profile", () => {
    const output = run(["--help"]);
    expect(output).toMatch(/loopover-mcp contributor-profile/);
  });

  it("also responds to the bare `help` command with the same usage banner", () => {
    const output = run(["help"]);
    expect(output).toMatch(/loopover-mcp maintain/);
    expect(output).toMatch(/loopover-mcp contributor-profile/);
  });
});

// #9860: the help banner's LOOPOVER_LOGIN line used to be a hand-typed prose list of commands, and it had
// already drifted -- omitting contributor-profile, explain-review-risk and watch, all of which take `--login`
// and resolve it through the same fallback. It is derived from CLI_COMMAND_SPEC now; these pin that the
// derivation stays truthful rather than merely stable.
describe("the LOOPOVER_LOGIN command list is derived, not remembered (#9860)", () => {
  const loginLine = () => run(["--help"]).split("\n").find((line) => line.includes("LOOPOVER_LOGIN")) ?? "";

  it("names the commands the old hand-written list had dropped", () => {
    const line = loginLine();
    for (const command of ["contributor-profile", "explain-review-risk", "watch"]) expect(line).toContain(command);
  });

  it("names EVERY command whose usage declares --login, and no others", async () => {
    // Read from the same table printHelp derives from, so a command added there shows up here by
    // construction. Comparing against a literal list would just move the hand-maintained list into a test.
    const { CLI_COMMAND_SPEC } = await import("../../packages/loopover-mcp/bin/loopover-mcp");
    const expected = Object.entries(CLI_COMMAND_SPEC)
      .filter(([, entry]) => entry.usage.some((usage: string) => usage.includes("--login")))
      .map(([name]) => name);
    expect(expected.length).toBeGreaterThan(5);

    const line = loginLine();
    for (const command of expected) expect(line).toContain(command);
    // And nothing that does NOT take --login is claimed. `login` itself is the trap: it is a real command
    // whose name is a substring of the flag, so a naive check would pass while the line was wrong.
    const notLoginDefaulting = Object.keys(CLI_COMMAND_SPEC).filter((name) => !expected.includes(name));
    const named = line.slice(line.indexOf("default --login for")).split(/[,()]/).map((part) => part.trim());
    for (const command of notLoginDefaulting) expect(named).not.toContain(command);
  });
});
