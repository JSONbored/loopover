import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for #5933: the AMS miner's DR script pair (backup-miner.sh / restore-miner.sh) must default
// their working directory to the miner's real, current config dir (`~/.config/loopover-miner`, per
// packages/loopover-miner/lib/local-store.js's resolveLocalStoreDbPath) and NOT the pre-rename
// `~/.config/gittensory-miner`, so an operator who never sets LOOPOVER_MINER_CONFIG_DIR backs up/restores real
// state instead of a directory that no longer exists after the rebrand's hard cutover. These are `scripts/**`
// shell files, outside Codecov's coverage.include, so this content check is their only automated guard for the
// default (the sibling miner-backup-restore-scripts.test.ts always sets LOOPOVER_MINER_CONFIG_DIR explicitly, so
// it never exercises the default). Pattern mirrors test/unit/miner-docker-compose.test.ts: readFileSync + assert.
const SCRIPTS_DIR = join(process.cwd(), "scripts");
const CURRENT_DEFAULT = "$HOME/.config/loopover-miner";

describe("miner DR scripts default config dir (#5933)", () => {
  for (const script of ["backup-miner.sh", "restore-miner.sh"]) {
    const source = readFileSync(join(SCRIPTS_DIR, script), "utf8");

    it(`${script} defaults STATE_DIR to the current ~/.config/loopover-miner`, () => {
      expect(source).toContain(`STATE_DIR="\${LOOPOVER_MINER_CONFIG_DIR:-${CURRENT_DEFAULT}}"`);
    });

    it(`${script} carries no pre-rename gittensory-miner residue`, () => {
      expect(source).not.toContain("gittensory-miner");
    });
  }
});
