import { describe, expect, it, vi } from "vitest";

const BIN_MODULE = "../bin/loopover-mcp.ts";
type BinModule = { runCli: (args: readonly string[]) => Promise<number | void> };

describe("loopover-mcp review-pr help", () => {
  it("documents the repeatable labels and issue flags and their precedence", async () => {
    const { runCli } = (await import(BIN_MODULE)) as BinModule;
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    try {
      await runCli(["review-pr", "--help"]);
    } finally {
      stdout.mockRestore();
    }

    const help = chunks.join("");
    expect(help).toContain("[--label <name>]...");
    expect(help).toContain("[--issue <number>]...");
    expect(help).toContain("--linked-issue takes precedence and --issue is ignored");
  });
});
