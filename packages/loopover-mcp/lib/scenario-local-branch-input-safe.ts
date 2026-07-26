/** Forbidden keys that indicate source-content upload in scenario / local-branch payloads. */
const FORBIDDEN_SOURCE_UPLOAD_KEYS =
  /^(?:sourceContent|sourceContents|fileContent|fileContents|rawSource|rawSourceContent|content|contents|diff|patch|rawDiff)$/i;

/**
 * Production safety guard for local-branch / scenario inputs: refuse source-content uploads and oversized
 * changedFiles metadata. Shared by `src/scenarios/input-model.ts` and the MCP local-branch collector (#8884).
 */
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
  // #8328: a present-but-non-array changedFiles must be rejected so the nested scan cannot be skipped.
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
