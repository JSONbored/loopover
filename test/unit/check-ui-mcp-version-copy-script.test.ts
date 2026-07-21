import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildStaleVersionMatchers,
  collectSourceFiles,
  collectVersionCopyFailures,
  isMinimumSupportedContext,
  isTextSource,
  readMinimumSupportedVersion,
  SCAN_TARGETS,
  SOURCE_LATEST_PATH,
  writeKnownLatestVersion,
} from "../../scripts/check-ui-mcp-version-copy.js";

const root = process.cwd();
const SCRIPT_PATH = "scripts/check-ui-mcp-version-copy.ts";
const sourceText = readFileSync(join(root, SOURCE_LATEST_PATH), "utf8");

function declaredConstant(name: string): string {
  const value = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(sourceText)?.[1];
  if (value === undefined)
    throw new Error(`Could not find ${name} in ${SOURCE_LATEST_PATH}.`);
  return value;
}

describe("check-ui-mcp-version-copy script (#6292)", () => {
  it("derives the minimum-supported floor from the shipped constant, so the scan can't drift", () => {
    // The whole point of #6292: the floor must come from the single source of truth the app ships, not a
    // hardcoded literal that froze several majors behind reality.
    const declared = declaredConstant("MCP_MINIMUM_SUPPORTED_VERSION");
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readMinimumSupportedVersion(join(root, SOURCE_LATEST_PATH))).toBe(
      declared,
    );
  });

  it("no longer hardcodes the years-stale 0.2 floor literal it was frozen at", () => {
    const scriptText = readFileSync(join(root, SCRIPT_PATH), "utf8");
    expect(scriptText).not.toContain("0.2");
  });

  describe("buildStaleVersionMatchers", () => {
    it("rejects a non-semver floor so a malformed source constant fails loudly", () => {
      expect(() => buildStaleVersionMatchers("0.5")).toThrow(/semver/);
    });

    it("targets the floor's own major.minor and exact version", () => {
      const matchers = buildStaleVersionMatchers("1.2.3");
      expect(matchers.floorVersion).toBe("1.2.3");
      expect(matchers.minorLabel).toBe("1.2");
      expect(matchers.visibleVersion.test("v1.2")).toBe(true);
      expect(matchers.visibleVersion.test("v1.2.3")).toBe(true);
      expect(matchers.versionRange.test("1.2.x")).toBe(true);
      expect(matchers.floor.test("1.2.3")).toBe(true);
      // A neighbouring release must not be mistaken for the floor.
      expect(matchers.floor.test("1.2.4")).toBe(false);
    });
  });

  describe("collectVersionCopyFailures", () => {
    const matchers = buildStaleVersionMatchers("0.5.0");

    it("flags a bare floor version used outside a minimum-supported statement", () => {
      const failures = collectVersionCopyFailures({
        label: "README.md",
        text: "@loopover/mcp/0.5.0 (api 0.1.0, node v22.12.0)",
        matchers,
      });
      expect(failures).toEqual([
        "README.md:1: 0.5.0 is only allowed as an explicit minimum-supported compatibility floor",
      ]);
    });

    it("allows the floor version when the line is an explicit minimum-supported floor", () => {
      const failures = collectVersionCopyFailures({
        label: "mcp-package.ts",
        text: 'export const MCP_MINIMUM_SUPPORTED_VERSION = "0.5.0";',
        matchers,
      });
      expect(failures).toEqual([]);
    });

    it("flags visible v-prefixed minor text and the .x range on the same line", () => {
      const failures = collectVersionCopyFailures({
        label: "a.md",
        text: "use v0.5 or the 0.5.x range",
        matchers,
      });
      expect(failures).toEqual([
        "a.md:1: stale visible v0.5 version text",
        "a.md:1: stale 0.5.x package-version range",
      ]);
    });

    it("does not flag the current package version or non-version 0.5 fragments", () => {
      const failures = collectVersionCopyFailures({
        label: "b.md",
        text: "@loopover/mcp/3.0.0\npy-0.5 gap-0.5\ntransition duration 0.2",
        matchers,
      });
      expect(failures).toEqual([]);
    });
  });

  describe("scanning the fumadocs-mdx content directory (#7093)", () => {
    let tempDir: string | undefined;

    afterEach(() => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    });

    it("includes the docs content directory and recognizes .mdx as a text source", () => {
      // Before #7093, SCAN_TARGETS only reached apps/loopover-ui/src and isTextSource didn't match .mdx, so the
      // fumadocs content pipeline (5003fabe) was entirely invisible to this drift check.
      expect(SCAN_TARGETS).toContain("apps/loopover-ui/content");
      expect(isTextSource("apps/loopover-ui/content/docs/quickstart.mdx")).toBe(true);
    });

    it("collectSourceFiles now picks up real .mdx files under apps/loopover-ui/content/docs", () => {
      const files = collectSourceFiles(join(root, "apps/loopover-ui/content"));
      expect(files.some((file) => file.endsWith(join("docs", "quickstart.mdx")))).toBe(true);
    });

    it("flags a stale @loopover/mcp floor version hardcoded in an .mdx file (the regression this scan now catches)", () => {
      tempDir = mkdtempSync(join(tmpdir(), "mcp-mdx-"));
      mkdirSync(join(tempDir, "docs"), { recursive: true });
      const mdxPath = join(tempDir, "docs", "quickstart.mdx");
      writeFileSync(mdxPath, "Install with `npx -y @loopover/mcp/0.5.0 --help`\n");

      // Discovery: the .mdx file is collected (it would have been skipped before the isTextSource change).
      expect(collectSourceFiles(tempDir)).toContain(mdxPath);

      // Flagging: its stale floor version is caught by the same matcher the src/ scan already uses.
      const matchers = buildStaleVersionMatchers("0.5.0");
      const failures = collectVersionCopyFailures({
        label: "docs/quickstart.mdx",
        text: readFileSync(mdxPath, "utf8"),
        matchers,
      });
      expect(failures).toContain(
        "docs/quickstart.mdx:1: 0.5.0 is only allowed as an explicit minimum-supported compatibility floor",
      );
    });
  });

  it("recognizes minimum-supported context markers", () => {
    expect(
      isMinimumSupportedContext("the minimum supported version is X"),
    ).toBe(true);
    expect(isMinimumSupportedContext("supportedVersionRange: >=X")).toBe(true);
    expect(isMinimumSupportedContext("just some prose")).toBe(false);
  });

  it("passes cleanly against the real repo docs with the registry check stubbed offline", () => {
    const knownLatest = declaredConstant("MCP_PACKAGE_KNOWN_LATEST_VERSION");
    const out = execFileSync(process.execPath, ["--experimental-strip-types", SCRIPT_PATH], {
      encoding: "utf8",
      env: { ...process.env, LOOPOVER_MCP_LATEST_VERSION: knownLatest },
    });
    expect(out).toContain("MCP UI version copy ok");
    expect(out).toContain(
      `minimum floor ${declaredConstant("MCP_MINIMUM_SUPPORTED_VERSION")}`,
    );
  });

  describe("writeKnownLatestVersion (#6580: self-healing known-latest, never a manual bump)", () => {
    let tempDir: string | undefined;

    afterEach(() => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    });

    it("replaces only the known-latest constant, leaving the rest of the file untouched", () => {
      tempDir = mkdtempSync(join(tmpdir(), "mcp-known-latest-"));
      const filePath = join(tempDir, "mcp-package.ts");
      writeFileSync(
        filePath,
        'export const MCP_PACKAGE_NAME = "@loopover/mcp";\nexport const MCP_PACKAGE_KNOWN_LATEST_VERSION = "0.6.0";\nexport const MCP_MINIMUM_SUPPORTED_VERSION = "0.5.0";\n',
      );

      writeKnownLatestVersion(filePath, "0.9.0");

      const updated = readFileSync(filePath, "utf8");
      expect(updated).toContain('MCP_PACKAGE_KNOWN_LATEST_VERSION = "0.9.0"');
      expect(updated).toContain('MCP_PACKAGE_NAME = "@loopover/mcp"'); // unrelated lines preserved
      expect(updated).toContain('MCP_MINIMUM_SUPPORTED_VERSION = "0.5.0"'); // the floor is untouched
    });

    it("throws when the target file has no known-latest constant to update", () => {
      tempDir = mkdtempSync(join(tmpdir(), "mcp-known-latest-"));
      const filePath = join(tempDir, "mcp-package.ts");
      writeFileSync(filePath, "export const SOMETHING_ELSE = 1;\n");

      expect(() => writeKnownLatestVersion(filePath, "0.9.0")).toThrow(
        /Could not find MCP_PACKAGE_KNOWN_LATEST_VERSION/,
      );
    });
  });

  describe("--write CLI mode (#6580)", () => {
    let tempDir: string | undefined;

    afterEach(() => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    });

    // Runs the real CLI end-to-end, but against a disposable temp repo layout -- never the real
    // apps/loopover-ui/src/lib/mcp-package.ts, so the test can never mutate this repo's own source file.
    function seedTempRepo(knownLatest: string): string {
      const dir = mkdtempSync(join(tmpdir(), "mcp-write-cli-"));
      mkdirSync(join(dir, "apps/loopover-ui/src/lib"), { recursive: true });
      // #7093: SCAN_TARGETS now includes apps/loopover-ui/content, so the seeded repo must have it too or the
      // scan's statSync would ENOENT. Empty is fine — collectSourceFiles returns [] for it.
      mkdirSync(join(dir, "apps/loopover-ui/content"), { recursive: true });
      mkdirSync(join(dir, "packages/loopover-mcp"), { recursive: true });
      writeFileSync(join(dir, "README.md"), "# repo\n");
      writeFileSync(join(dir, "packages/loopover-mcp/README.md"), "# mcp\n");
      writeFileSync(
        join(dir, "apps/loopover-ui/src/lib/mcp-package.ts"),
        `export const MCP_PACKAGE_KNOWN_LATEST_VERSION = "${knownLatest}";\nexport const MCP_MINIMUM_SUPPORTED_VERSION = "0.5.0";\n`,
      );
      return dir;
    }

    it("self-heals a stale known-latest constant instead of failing", () => {
      tempDir = seedTempRepo("0.6.0");
      const out = execFileSync(
        process.execPath,
        ["--experimental-strip-types", join(process.cwd(), SCRIPT_PATH), "--write"],
        { encoding: "utf8", cwd: tempDir, env: { ...process.env, LOOPOVER_MCP_LATEST_VERSION: "0.9.0" } },
      );
      expect(out).toContain("updated known latest 0.6.0 -> 0.9.0");
      const updated = readFileSync(join(tempDir, "apps/loopover-ui/src/lib/mcp-package.ts"), "utf8");
      expect(updated).toContain('MCP_PACKAGE_KNOWN_LATEST_VERSION = "0.9.0"');
    });

    it("is a no-op when the known-latest constant is already current", () => {
      tempDir = seedTempRepo("0.9.0");
      const out = execFileSync(
        process.execPath,
        ["--experimental-strip-types", join(process.cwd(), SCRIPT_PATH), "--write"],
        { encoding: "utf8", cwd: tempDir, env: { ...process.env, LOOPOVER_MCP_LATEST_VERSION: "0.9.0" } },
      );
      expect(out).not.toContain("updated known latest");
      expect(out).toContain("MCP UI version copy ok");
    });
  });
});
