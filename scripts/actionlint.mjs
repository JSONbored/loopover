import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { actionlint } = require("github-actionlint");

const workflowDir = ".github/workflows";
const files = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => join(workflowDir, name));

if (files.length === 0) {
  console.error(`No workflow files found in ${workflowDir}`);
  process.exit(1);
}

const maxAttempts = Math.max(1, Number.parseInt(process.env.ACTIONLINT_DOWNLOAD_ATTEMPTS ?? "4", 10) || 4);
const retryDelaysMs = [1000, 3000, 7000];
const retryableSetupError = /Download failed: (?:408|425|429|5\d\d)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runWasmActionlint(reason) {
  console.warn(`official actionlint setup unavailable, using WASM fallback: ${reason}`);
  const { getLintLog, runLint } = require("@tktco/node-actionlint");
  const fileData = files.map((file) => ({ path: file, data: readFileSync(file, "utf8") }));
  const results = (
    await Promise.all(
      fileData.map(async (file) => {
        const lintResults = await runLint(file.data, file.path);
        return lintResults.map((result) => ({ ...result, ...file }));
      }),
    )
  )
    .flat()
    .filter((result) => result.message);
  const log = getLintLog(results);
  if (log) {
    console.error(log);
    return { code: 1 };
  }
  return { code: 0 };
}

async function runActionlint() {
  if (process.env.ACTIONLINT_FORCE_WASM_FALLBACK === "1") {
    return runWasmActionlint("forced by ACTIONLINT_FORCE_WASM_FALLBACK");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await actionlint({ args: files, spawnOptions: { stdio: "inherit" } });
    } catch (error) {
      const message = errorMessage(error);
      if (!retryableSetupError.test(message)) throw error;
      if (attempt >= maxAttempts) return runWasmActionlint(message);
      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)];
      console.warn(`actionlint setup failed, retrying (${attempt}/${maxAttempts}): ${message}`);
      await delay(delayMs);
    }
  }
  throw new Error("actionlint setup failed without returning a result");
}

const result = await runActionlint();
process.exit(result.code);
// cache-verification no-op 1783739035
