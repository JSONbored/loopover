import { describe, expect, it } from "vitest";
import { run } from "./support/mcp-cli-harness";

// #6991: printHelp() listed ~30 real top-level commands but omitted two dispatched ones: `maintain`
// (packages/loopover-mcp/bin/loopover-mcp.js's maintainCli) and `contributor-profile`
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
