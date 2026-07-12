import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Drift guard for the miner README's "Recognizing a stale or missing coding-agent credential" table
// (#5175). The table documents credential/auth failure modes surfaced by the CLI-subprocess driver, so
// every error string it lists MUST correspond to a literal constant actually emitted by the driver source
// -- otherwise the docs silently drift from the code. This is a documentation-only change, so there is no
// production behavior to regression-test; the driver's own error-string vocabulary is covered by
// test/unit/cli-subprocess-driver.test.ts (#5168/#5169). These tests only pin the docs↔code link.

const readmePath = join(process.cwd(), "packages/gittensory-miner/README.md");
const driverPath = join(process.cwd(), "packages/gittensory-engine/src/miner/cli-subprocess-driver.ts");

/** Each row of the README table: the error token as it appears in the first column, and the literal stem
 *  the CLI-subprocess driver source must actually contain to back it. Placeholders (`<status>`, `<code>`,
 *  `<command>`) are dynamic; the stem is the stable substring the driver emits verbatim. */
const CREDENTIAL_ERROR_ROWS = [
  { readmeToken: "claude_code_error_<status>", sourceStem: "claude_code_error_" },
  { readmeToken: "codex_no_auth", sourceStem: "codex_no_auth" },
  { readmeToken: "<command>_exit_<code>", sourceStem: "_exit_" },
] as const;

/** Slice the README down to the credential-troubleshooting section (heading → next heading). */
function readCredentialSection(): string {
  const readme = readFileSync(readmePath, "utf8");
  const heading = "### Recognizing a stale or missing coding-agent credential";
  const start = readme.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = readme.slice(start + heading.length);
  const nextHeading = rest.search(/\n#{1,3} /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

/** Pull every inline-code token out of the first column of each markdown table row in the section. */
function firstColumnErrorTokens(section: string): string[] {
  const tokens: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    // A data row starts with "|", excludes the header ("Error string") and the "| --- |" separator.
    if (!trimmed.startsWith("|") || trimmed.includes("---") || trimmed.includes("Error string")) continue;
    const firstCell = trimmed.split("|")[1]?.trim() ?? "";
    const match = firstCell.match(/`([^`]+)`/);
    if (match?.[1]) tokens.push(match[1]);
  }
  return tokens;
}

describe("gittensory-miner credential-troubleshooting README (#5175)", () => {
  it("adds the credential-troubleshooting section covering the three required failure modes", () => {
    const section = readCredentialSection();
    expect(section).toContain("Error string / pattern");
    expect(section).toContain("Symptom");
    expect(section).toContain("Remediation");
    // The three required cases: Claude Code envelope error, Codex auth failure, and the generic fallback.
    for (const { readmeToken } of CREDENTIAL_ERROR_ROWS) {
      expect(section).toContain(readmeToken);
    }
  });

  it("backs every documented error string with a literal constant in the CLI-subprocess driver source", () => {
    const driverSrc = readFileSync(driverPath, "utf8");
    for (const { readmeToken, sourceStem } of CREDENTIAL_ERROR_ROWS) {
      expect(driverSrc, `${readmeToken} must be backed by "${sourceStem}" in the driver`).toContain(sourceStem);
    }
  });

  it("invariant: the table never contains a first-column error string that is not backed by a driver constant", () => {
    const section = readCredentialSection();
    const driverSrc = readFileSync(driverPath, "utf8");
    const tokens = firstColumnErrorTokens(section);
    // The parse actually found the rows (guards against a silently-empty extraction masking drift).
    expect(tokens).toEqual(CREDENTIAL_ERROR_ROWS.map((r) => r.readmeToken));
    for (const token of tokens) {
      // Strip the dynamic `<...>` placeholders; whatever literal stem remains must exist in the driver.
      const stem = token.replace(/<[^>]*>/g, "");
      expect(stem.length).toBeGreaterThan(0);
      expect(driverSrc, `no driver constant backs README token "${token}" (stem "${stem}")`).toContain(stem);
    }
  });
});
