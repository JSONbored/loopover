#!/usr/bin/env node
// A migration that has shipped in a release is IMMUTABLE (#9420 regression).
//
// THE INCIDENT THIS EXISTS FOR: #9420 updated a doc COMMENT inside migrations/0180_decision_ledger.sql --
// no DDL change at all -- and shipped it in orb-v3.5.0. But runSelfHostMigrations (src/selfhost/migrate.ts)
// records a sha256 of each applied migration's FULL TEXT and, on every boot, re-hashes the on-disk file and
// throws `selfhost_migration_content_drift` if it differs. Comments are part of that text. So the moment any
// already-upgraded deployment pulled the new image it would refuse to start -- not degrade, not warn: fail
// to boot, with the review pipeline down until a human restored the file. Nothing caught it: the existing
// db:migrations:check guards NUMBERING (collisions, gaps, filenames), and git reports a clean one-file diff
// because editing a file is not a conflict.
//
// The rule is therefore mechanical, and this is the check that enforces it: once a migration file exists in
// any released `orb-v*` tag, its bytes may never change again. Not the DDL, not a typo, not a comment.
// Forward-only means forward-only -- to change what a migration DID, add a new one; to change what it SAYS,
// put the prose in the source module that reads the table (see src/review/decision-record.ts's header for
// exactly this split).
//
// Deleting a released migration is likewise refused. migrate.ts tolerates a ledger row whose file has
// vanished (it skips unknown names), but a fresh deployment would then build a different schema than every
// existing one -- a silent divergence this check would rather stop at the PR.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_REBASELINE } from "./migration-rebaseline";

/** A released tag and the migration blobs it shipped, as `name -> blob sha`. */
export type ReleasedTagManifest = { tag: string; files: ReadonlyMap<string, string> };

export type MigrationViolation = { file: string; tag: string; kind: "modified" | "deleted" };

/**
 * PURE core: any file whose blob sha differs from (or is missing versus) the one it was FIRST released with.
 *
 * The baseline is deliberately the EARLIEST tag that shipped each file, not every tag. A file's first
 * release is when it froze: that is the content the oldest deployments applied and recorded a hash for, and
 * they are both the most numerous and the ones with the most history to lose. Checking against every tag
 * would be wrong here for a concrete reason -- when a released migration HAS been mutated (the #9420
 * incident), the released tags themselves disagree with each other, so no content could satisfy all of them
 * and the check could never go green again, not even after the correct repair.
 *
 * `released` must be ordered oldest-first; first sighting of a file wins.
 */
export function findMutatedReleasedMigrations(
  released: readonly ReleasedTagManifest[],
  current: ReadonlyMap<string, string>,
): MigrationViolation[] {
  const frozen = new Map<string, { tag: string; blob: string }>();
  for (const { tag, files } of released) {
    for (const [file, blob] of files) if (!frozen.has(file)) frozen.set(file, { tag, blob });
  }
  // Files edited before this guard existed are re-frozen at their current content instead of their first
  // release -- see migration-rebaseline.ts for why that is safe here and why the table must never grow.
  for (const [file, blob] of MIGRATION_REBASELINE) {
    const existing = frozen.get(file);
    if (existing) frozen.set(file, { tag: existing.tag, blob });
  }

  const violations: MigrationViolation[] = [];
  for (const [file, { tag, blob }] of frozen) {
    const currentBlob = current.get(file);
    if (currentBlob === undefined) violations.push({ file, tag, kind: "deleted" });
    else if (currentBlob !== blob) violations.push({ file, tag, kind: "modified" });
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file));
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** `migrations/*.sql` at a given rev, as `name -> blob sha`. */
function migrationsAt(rev: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const line of git("ls-tree", "-r", rev, "--", "migrations/").split("\n")) {
    // `<mode> blob <sha>\t<path>`
    const match = /^\d+ blob ([0-9a-f]+)\t(migrations\/.+\.sql)$/.exec(line);
    if (match?.[1] && match[2]) files.set(match[2].slice("migrations/".length), match[1]);
  }
  return files;
}

/** Released ORB tags, oldest first, so the earliest tag to freeze a file is the one reported. */
export function releasedOrbTags(): string[] {
  return git("tag", "-l", "orb-v*", "--sort=creatordate").split("\n").filter(Boolean);
}

/**
 * The migrations as they exist ON DISK, hashed with git's own blob algorithm so they compare directly
 * against `ls-tree` output.
 *
 * Deliberately NOT `ls-tree HEAD`: that reads the committed tree and is blind to uncommitted edits, so the
 * check would go green locally on exactly the change it exists to reject and only fail later in CI. Reading
 * the working tree makes it usable as a pre-commit check and makes what it reports match what the author is
 * actually about to ship.
 */
function migrationsOnDisk(): Map<string, string> {
  const files = new Map<string, string>();
  const names = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
  if (names.length === 0) return files;
  // One batched hash-object call: 200 separate spawns is the difference between instant and noticeable.
  const hashes = git("hash-object", "--", ...names.map((name) => join("migrations", name))).split("\n").filter(Boolean);
  names.forEach((name, index) => {
    const hash = hashes[index];
    if (hash) files.set(name, hash);
  });
  return files;
}

function main(): void {
  const tags = releasedOrbTags();
  if (tags.length === 0) {
    // A shallow clone or a fork with no tags cannot evaluate this rule. Say so rather than passing silently:
    // a check that quietly becomes a no-op is how the thing it guards comes back.
    console.error("released-migrations-immutable: no orb-v* tags visible — fetch tags (`git fetch --tags`) so this check can run.");
    process.exit(1);
  }
  const released = tags.map((tag) => ({ tag, files: migrationsAt(tag) }));
  const violations = findMutatedReleasedMigrations(released, migrationsOnDisk());

  if (violations.length > 0) {
    console.error("A migration that already shipped in a release was changed. Released migrations are immutable:\n");
    for (const { file, tag, kind } of violations) {
      console.error(`  migrations/${file} — ${kind} (first released in ${tag})`);
    }
    console.error(
      "\n  Every deployment that already applied one of these recorded a sha256 of its FULL text (comments\n" +
        "  included). src/selfhost/migrate.ts re-hashes on every boot and throws selfhost_migration_content_drift\n" +
        "  on a mismatch, so shipping this would make every already-upgraded ORB FAIL TO BOOT.\n\n" +
        "  To change what a migration DID: add a new migrations/NNNN_*.sql.\n" +
        "  To change what it SAYS: put the prose in the source module that reads the table, not the .sql.\n" +
        "  To undo an accidental edit: git checkout <tag> -- migrations/<file>",
    );
    process.exit(1);
  }
  const frozen = new Set(released.flatMap(({ files }) => [...files.keys()])).size;
  console.log(`released-migrations-immutable: OK — ${frozen} released migration(s) unchanged across ${tags.length} orb-v tag(s).`);
}

if (process.argv[1]?.endsWith("check-released-migrations-immutable.ts")) main();
