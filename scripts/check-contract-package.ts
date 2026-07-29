#!/usr/bin/env node
// Pack check for @loopover/contract (#9654), mirroring check-mcp-package.ts.
//
// The contract package became publishable in #9749 because it is a RUNTIME dependency of both published
// CLIs. A published tarball is immutable, so the file list and its contents are checked BEFORE the
// publish job ever sees them — the same reasoning as the MCP check, against this package's own allowlist.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_CONTENT } from "./forbidden-content";
import { CONTRACT_PACKAGE_ALLOWED_FILE_PATTERNS } from "./contract-package-allowlist";

const FORBIDDEN_PATH = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;

type PackedFile = string | { path: string };
type ReadContentFn = (file: string) => string;

/** PURE over an already-resolved pack listing, so the rules are unit-testable without running npm. */
export function validateContractPackFileList(files: readonly PackedFile[], readContent: ReadContentFn): string[] {
  const paths = files.map((file) => (typeof file === "string" ? file : file.path)).sort();
  if (paths.length === 0) throw new Error("Contract package tarball is empty");
  for (const file of paths) {
    if (FORBIDDEN_PATH.test(file)) throw new Error(`Forbidden file in contract package: ${file}`);
    if (!CONTRACT_PACKAGE_ALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(file))) {
      throw new Error(`Unexpected file in contract package: ${file}`);
    }
    if (FORBIDDEN_CONTENT.test(readContent(file))) throw new Error(`Secret-like content found in contract package file: ${file}`);
  }
  return paths;
}

function loadContractPackFromNpm(): { files: PackedFile[] } {
  const result = spawnSync("npm", ["pack", "--workspace", "@loopover/contract", "--dry-run", "--json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout) as Array<{ files: PackedFile[] }>;
  const pack = parsed[0];
  if (!pack) throw new Error("npm pack returned no package entry");
  return pack;
}

export function runContractPackCheck(
  options: { pack?: { files: PackedFile[] }; packageRoot?: string; readContent?: ReadContentFn } = {},
): string {
  const packageRoot = options.packageRoot ?? join(fileURLToPath(import.meta.url), "..", "..", "packages", "loopover-contract");
  const readContent: ReadContentFn =
    options.readContent ??
    ((file) => {
      try {
        return readFileSync(join(packageRoot, file), "utf8");
      } catch {
        // A binary or unreadable file has no text to scan; the allowlist above already bounds what may ship.
        return "";
      }
    });
  const paths = validateContractPackFileList((options.pack ?? loadContractPackFromNpm()).files, readContent);
  return `check-contract-package: OK — ${paths.length} packed file(s), all allowlisted and clean.`;
}

if (process.argv[1]?.endsWith("check-contract-package.ts")) {
  try {
    console.log(runContractPackCheck());
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
