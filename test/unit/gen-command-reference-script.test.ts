import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommandCatalogEntry,
  collectCommandCatalogs,
  DEFAULT_OUTPUT_PATH,
  extractCatalogEntries,
  renderCommandList,
  renderCommandReferenceModule,
} from "../../scripts/gen-command-reference.mjs";

function fixtureRoot(commandsSource: string): string {
  const root = mkdtempSync(join(tmpdir(), "gt-command-reference-"));
  mkdirSync(join(root, "src", "github"), { recursive: true });
  writeFileSync(join(root, "src", "github", "commands.ts"), commandsSource);
  return root;
}

describe("gen-command-reference script (#3046)", () => {
  describe("extractCatalogEntries", () => {
    const fixture = `
      const PUBLIC_MENTION_COMMAND_CATALOG = [
        { id: "help", title: "Help", description: "Show help." },
        { id: "ask", title: "Ask", description: "Answer a question." },
      ] as const;

      const MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG = [
        { id: "queue-summary", title: "Queue summary", description: "Post a queue digest." },
      ] as const;
    `;

    it("extracts only the entries from the named catalog, not the other one, in source order", () => {
      expect(extractCatalogEntries(fixture, "PUBLIC_MENTION_COMMAND_CATALOG")).toEqual([
        { id: "help", title: "Help", description: "Show help." },
        { id: "ask", title: "Ask", description: "Answer a question." },
      ]);
      expect(extractCatalogEntries(fixture, "MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG")).toEqual([
        { id: "queue-summary", title: "Queue summary", description: "Post a queue digest." },
      ]);
    });

    it("returns an empty array when the named catalog does not exist", () => {
      expect(extractCatalogEntries(fixture, "MISSING_CATALOG")).toEqual([]);
    });
  });

  describe("renderCommandList", () => {
    it("renders one @gittensory <id> line per entry, newline-joined, in order", () => {
      expect(
        renderCommandList([
          { id: "help", title: "Help", description: "Show help." },
          { id: "ask", title: "Ask", description: "Answer a question." },
        ]),
      ).toBe("@gittensory help\n@gittensory ask");
    });

    it("renders an empty string for an empty catalog", () => {
      expect(renderCommandList([])).toBe("");
    });
  });

  describe("collectCommandCatalogs", () => {
    it("self-defends against a broken extraction regex (fewer than 15 total commands)", () => {
      const root = fixtureRoot(`
        const PUBLIC_MENTION_COMMAND_CATALOG = [{ id: "only-one", title: "Only", description: "One." }] as const;
        const MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG = [] as const;
      `);

      expect(() => collectCommandCatalogs({ rootDir: root })).toThrow(/extraction regex may be broken/);
    });

    it("extracts a fixture with exactly 15 total commands without throwing", () => {
      const publicIds = Array.from({ length: 10 }, (_, i) => `{ id: "public-${i}", title: "Public ${i}", description: "Desc ${i}." },`).join("\n");
      const maintainerIds = Array.from({ length: 5 }, (_, i) => `{ id: "maint-${i}", title: "Maint ${i}", description: "Desc ${i}." },`).join("\n");
      const root = fixtureRoot(`
        const PUBLIC_MENTION_COMMAND_CATALOG = [
          ${publicIds}
        ] as const;
        const MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG = [
          ${maintainerIds}
        ] as const;
      `);

      const { publicCommands, maintainerCommands } = collectCommandCatalogs({ rootDir: root });
      expect(publicCommands).toHaveLength(10);
      expect(maintainerCommands).toHaveLength(5);
    });

    it("extracts the real 10 public + 9 maintainer-only commands from the real repo source", () => {
      const { publicCommands, maintainerCommands } = collectCommandCatalogs({ rootDir: process.cwd() });

      expect(publicCommands).toHaveLength(10);
      expect(maintainerCommands).toHaveLength(9);
      expect(publicCommands.map((c: CommandCatalogEntry) => c.id)).toEqual([
        "help",
        "ask",
        "preflight",
        "blockers",
        "duplicate-check",
        "miner-context",
        "next-action",
        "reviewability",
        "repo-fit",
        "packet",
      ]);
      expect(maintainerCommands.map((c: CommandCatalogEntry) => c.id)).toEqual([
        "queue-summary",
        "confirmed-miners",
        "review-now",
        "needs-author",
        "duplicate-clusters",
        "burden-forecast",
        "intake-health",
        "outcome-patterns",
        "noise-report",
      ]);
    });
  });

  describe("renderCommandReferenceModule", () => {
    it("renders a generated-file header plus both exported string constants", () => {
      const output = renderCommandReferenceModule({
        publicCommands: [{ id: "help", title: "Help", description: "Show help." }],
        maintainerCommands: [{ id: "queue-summary", title: "Queue summary", description: "Post a digest." }],
      });

      expect(output).toContain("// Generated by scripts/gen-command-reference.mjs. Do not edit manually.");
      expect(output).toContain("npm run command-reference");
      expect(output).toContain('export const PUBLIC_COMMAND_LIST =\n  "@gittensory help";');
      expect(output).toContain('export const MAINTAINER_COMMAND_LIST =\n  "@gittensory queue-summary";');
    });
  });

  // Most important regression test in this file: proves the committed generated file on disk is
  // byte-identical to what the generator's pure function would produce right now from the real
  // src/github/commands.ts. If this fails, either the generated file is stale (run
  // `npm run command-reference` and commit it) or the extraction logic changed -- either way, the
  // generated file must not be hand-edited to make this test pass.
  it("the committed generated file matches what the generator would produce right now (regression guard)", () => {
    const rootDir = process.cwd();
    const { publicCommands, maintainerCommands } = collectCommandCatalogs({ rootDir });
    const expected = renderCommandReferenceModule({ publicCommands, maintainerCommands });

    const actual = readFileSync(resolve(rootDir, DEFAULT_OUTPUT_PATH), "utf8");

    expect(actual).toBe(expected);
  });

  it("prints a clean summary and exits 0 for the real repo state when run as a subprocess with --check", () => {
    const output = execFileSync("node", ["scripts/gen-command-reference.mjs", "--check"], { encoding: "utf8" });

    expect(output).toMatch(/gen-command-reference: checked \d+ public \+ \d+ maintainer-only command references in/);
  });
});
