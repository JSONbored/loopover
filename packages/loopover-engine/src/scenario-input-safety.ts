// Shared local-branch scenario-input safety guard. Lives in the engine so BOTH the LoopOver backend
// (src/scenarios/input-model.ts re-exports it) and the loopover-mcp production local-branch collector
// (packages/loopover-mcp/lib/local-branch.ts) enforce the exact same metadata-only contract -- the
// forbidden-source-upload-key / oversized-content scan is the documented safety mechanism and must run
// on the real collection path, not just its own unit test.
const FORBIDDEN_SOURCE_UPLOAD_KEYS =
  /^(?:sourceContent|sourceContents|fileContent|fileContents|rawSource|rawSourceContent|content|contents|diff|patch|rawDiff)$/i;

export function assertScenarioLocalBranchInputSafe(payload: Record<string, unknown>): void {
  if (/^(1|true|yes)$/i.test(String(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false"))) {
    throw new Error("LOOPOVER_UPLOAD_SOURCE=true is not supported; scenario inputs remain metadata-only.");
  }
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_SOURCE_UPLOAD_KEYS.test(key)) {
      throw new Error(`Refusing scenario local-branch field ${key}; source contents are never uploaded.`);
    }
  }
  const changedFiles = payload.changedFiles;
  // #8328: a present-but-non-array changedFiles (a plain object like { diff: "…source…" }, a string, a number)
  // is not the documented array-of-entries shape, and the Array.isArray guard below would silently skip the
  // entire forbidden-key/oversize scan for it — letting exactly the source content this validator exists to
  // refuse slip through unchecked. Reject it outright; an omitted / undefined changedFiles stays allowed.
  if (changedFiles !== undefined && !Array.isArray(changedFiles)) {
    throw new Error("Refusing non-array changedFiles; an array of file entries is required.");
  }
  if (Array.isArray(changedFiles)) {
    for (const entry of changedFiles) {
      if (!entry || typeof entry !== "object") continue;
      for (const nestedKey of Object.keys(entry as Record<string, unknown>)) {
        if (FORBIDDEN_SOURCE_UPLOAD_KEYS.test(nestedKey)) {
          throw new Error(`Refusing changedFiles.${nestedKey}; source contents are never uploaded.`);
        }
        const value = (entry as Record<string, unknown>)[nestedKey];
        if (typeof value === "string" && value.length > 4000) {
          throw new Error("Refusing oversized changedFiles payload; metadata-only paths are required.");
        }
      }
    }
  }
}
