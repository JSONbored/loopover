/** The bootstrap schema every store creates inline is, by convention, schema version 1. */
export const BASELINE_SCHEMA_VERSION = 1;
/** Read a store's current `PRAGMA user_version`, coercing any absent/invalid value to 0 (pre-versioning). */
export function readSchemaVersion(db) {
    const row = db.prepare("PRAGMA user_version").get();
    const raw = row ? Number(row.user_version) : 0;
    return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}
/**
 * Bring a store's on-disk schema up to date, then stamp its `user_version`. `migrations[i]` upgrades from
 * version i+1 to i+2, so the target version is `BASELINE_SCHEMA_VERSION + migrations.length`. Every migration
 * whose resulting version is above the file's current version runs, in order; a file already at (or past) the
 * target runs none. Returns the resulting version. Never runs a migration twice (the stamped `user_version`
 * gates re-runs on the next open) and never DOWNGRADES: a file written by newer code with more migrations is
 * left at its higher version rather than stamped back down. Each migration and its version stamp are applied in
 * one transaction, so a failure part-way through the sequence leaves the file at the last fully-applied version
 * and re-opening resumes at the failed migration (a throwing migration rethrows after its changes roll back).
 */
export function applySchemaMigrations(db, migrations = []) {
    const target = BASELINE_SCHEMA_VERSION + migrations.length;
    const current = readSchemaVersion(db);
    // A pre-versioning file (0) already holds the baseline schema, so advance from the baseline, not from 0.
    const effective = current < BASELINE_SCHEMA_VERSION ? BASELINE_SCHEMA_VERSION : current;
    // Stamp a pre-versioning file up to the baseline first, so a store with NO post-baseline migrations still
    // records a version. Only ever stamp UPWARD: a file already at or past the baseline (including one written by
    // newer code with more migrations) is never downgraded. `user_version` is an integer PRAGMA that cannot be
    // parameterized; every stamped value here is a computed integer, never caller text, so interpolating is safe.
    if (current < BASELINE_SCHEMA_VERSION) {
        db.exec(`PRAGMA user_version = ${BASELINE_SCHEMA_VERSION}`);
    }
    for (let version = effective; version < target; version += 1) {
        // Apply each migration AND stamp its resulting version in ONE transaction, so a failure part-way through the
        // sequence leaves the file at the LAST fully-applied version: the next open resumes at the failed migration
        // rather than re-running the ones that already succeeded (which, for a non-idempotent ALTER, would be a hard
        // duplicate-column error). PRAGMA user_version is transactional in SQLite, so ROLLBACK undoes the migration's
        // partial changes and its version stamp together.
        db.exec("BEGIN");
        try {
            const migration = migrations[version - BASELINE_SCHEMA_VERSION];
            // Index is in-range by construction (`version < target` and `target = BASELINE + migrations.length`).
            migration(db);
            db.exec(`PRAGMA user_version = ${version + 1}`);
            db.exec("COMMIT");
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
    // The resulting on-disk version: `target` after an upgrade, or the file's own higher version when it was
    // written by newer code (never downgraded).
    return Math.max(current, target);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NoZW1hLXZlcnNpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzY2hlbWEtdmVyc2lvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFvQkEsMkZBQTJGO0FBQzNGLE1BQU0sQ0FBQyxNQUFNLHVCQUF1QixHQUFHLENBQUMsQ0FBQztBQUV6Qyw2R0FBNkc7QUFDN0csTUFBTSxVQUFVLGlCQUFpQixDQUFDLEVBQWdCO0lBQ2hELE1BQU0sR0FBRyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMscUJBQXFCLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUNwRCxNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMvQyxPQUFPLE1BQU0sQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDckQsQ0FBQztBQUVEOzs7Ozs7Ozs7R0FTRztBQUNILE1BQU0sVUFBVSxxQkFBcUIsQ0FBQyxFQUFnQixFQUFFLGFBQWdDLEVBQUU7SUFDeEYsTUFBTSxNQUFNLEdBQUcsdUJBQXVCLEdBQUcsVUFBVSxDQUFDLE1BQU0sQ0FBQztJQUMzRCxNQUFNLE9BQU8sR0FBRyxpQkFBaUIsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUN0Qyx5R0FBeUc7SUFDekcsTUFBTSxTQUFTLEdBQUcsT0FBTyxHQUFHLHVCQUF1QixDQUFDLENBQUMsQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO0lBQ3hGLDBHQUEwRztJQUMxRyw4R0FBOEc7SUFDOUcsMkdBQTJHO0lBQzNHLDhHQUE4RztJQUM5RyxJQUFJLE9BQU8sR0FBRyx1QkFBdUIsRUFBRSxDQUFDO1FBQ3RDLEVBQUUsQ0FBQyxJQUFJLENBQUMseUJBQXlCLHVCQUF1QixFQUFFLENBQUMsQ0FBQztJQUM5RCxDQUFDO0lBQ0QsS0FBSyxJQUFJLE9BQU8sR0FBRyxTQUFTLEVBQUUsT0FBTyxHQUFHLE1BQU0sRUFBRSxPQUFPLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDN0QsNkdBQTZHO1FBQzdHLDRHQUE0RztRQUM1Ryw2R0FBNkc7UUFDN0csOEdBQThHO1FBQzlHLGtEQUFrRDtRQUNsRCxFQUFFLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2pCLElBQUksQ0FBQztZQUNILE1BQU0sU0FBUyxHQUFHLFVBQVUsQ0FBQyxPQUFPLEdBQUcsdUJBQXVCLENBQUMsQ0FBQztZQUNoRSxzR0FBc0c7WUFDdEcsU0FBVSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ2YsRUFBRSxDQUFDLElBQUksQ0FBQyx5QkFBeUIsT0FBTyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDaEQsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUNwQixDQUFDO1FBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztZQUNmLEVBQUUsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDcEIsTUFBTSxLQUFLLENBQUM7UUFDZCxDQUFDO0lBQ0gsQ0FBQztJQUNELHlHQUF5RztJQUN6Ryw0Q0FBNEM7SUFDNUMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQztBQUNuQyxDQUFDIn0=