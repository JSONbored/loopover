import { describe, expect, it } from "vitest";
import { validateContractPackFileList } from "../../scripts/check-contract-package";
import { CONTRACT_PACKAGE_ALLOWED_FILE_PATTERNS } from "../../scripts/contract-package-allowlist";
import { MCP_PACKAGE_ALLOWED_FILE_PATTERNS } from "../../scripts/mcp-package-allowlist";

// #9654: @loopover/contract becomes publishable, and a published tarball is immutable — so what may ship
// is checked before the publish job ever sees it, against this package's OWN allowlist.

const clean = () => "";

describe("validateContractPackFileList (#9654)", () => {
  it("accepts the real shape: emitted modules, declarations, maps, and the metadata files", () => {
    const paths = validateContractPackFileList(
      ["dist/index.js", "dist/index.d.ts", "dist/index.js.map", "dist/tools.d.ts.map", "package.json", "README.md", "CHANGELOG.md", "LICENSE"],
      clean,
    );
    expect(paths).toHaveLength(8);
  });

  it("REGRESSION: rejects a file nobody allowlisted, so a stray emit cannot ship unnoticed", () => {
    // A plain unexpected file (the forbidden-PATH rule below catches the secret-shaped names separately).
    expect(() => validateContractPackFileList(["dist/index.js", "src/index.ts"], clean)).toThrow(/Unexpected file/);
    expect(() => validateContractPackFileList(["dist/index.js", "tsconfig.json"], clean)).toThrow(/Unexpected file/);
    expect(() => validateContractPackFileList(["dist/index.js", ".npmrc"], clean)).toThrow(/Forbidden file/);
    expect(() => validateContractPackFileList(["dist/index.js", "deploy/id_rsa.pem"], clean)).toThrow(/Forbidden file/);
  });

  it("REGRESSION: rejects secret-like CONTENT even in an allowlisted file", () => {
    // This fired for real on first run: dist/telemetry.js carried a literal PEM header inside a doc
    // comment. Not a leaked credential, but a string that trips every scanner a consumer might run, so it
    // was removed at the source rather than excluded here.
    expect(() =>
      validateContractPackFileList(["dist/telemetry.js"], () => "const example = '-----BEGIN RSA PRIVATE KEY-----';"),
    ).toThrow(/Secret-like content/);
  });

  it("an empty tarball is a failure, not a pass — a broken build must not publish as 'clean'", () => {
    expect(() => validateContractPackFileList([], clean)).toThrow(/empty/);
  });

  it("accepts npm's object-shaped pack entries as well as bare strings", () => {
    expect(validateContractPackFileList([{ path: "dist/index.js" }, "package.json"], clean)).toEqual(["dist/index.js", "package.json"]);
  });

  it("REGRESSION: the contract allowlist is its OWN, not a reuse of the MCP one", () => {
    // The two packages ship completely different trees; sharing a list would over-permit one and
    // under-permit the other, which is how a package starts shipping a file nobody reviewed.
    expect(CONTRACT_PACKAGE_ALLOWED_FILE_PATTERNS).not.toBe(MCP_PACKAGE_ALLOWED_FILE_PATTERNS);
    // MCP's named CLI entrypoint is not allowlisted here...
    expect(CONTRACT_PACKAGE_ALLOWED_FILE_PATTERNS.some((p) => p.test("scripts/gittensor-score-preview.mjs"))).toBe(false);
    // ...and the contract's arbitrary dist modules are not allowlisted by MCP's.
    expect(MCP_PACKAGE_ALLOWED_FILE_PATTERNS.some((p) => p.test("dist/agent-specs.d.ts"))).toBe(false);
    expect(CONTRACT_PACKAGE_ALLOWED_FILE_PATTERNS.some((p) => p.test("dist/agent-specs.d.ts"))).toBe(true);
  });
});
