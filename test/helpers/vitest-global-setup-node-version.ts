import { checkNodeVersion } from "../../scripts/check-node-version.js";

/**
 * Vitest `globalSetup` -- the only mechanism that covers *every* vitest invocation path, not just
 * specific npm script names. scripts/check-node-version.ts's `pretest*` hooks (package.json) only fire
 * for the exact npm script names they're wired to -- they can never cover a direct
 * `npx vitest run test/unit/<file>.test.ts` invocation, which the contributing skill docs explicitly
 * recommend for fast iteration (reference.md, SKILL.md). A globalSetup runs once before any test file,
 * regardless of how vitest was invoked, so this is the real backstop; the pretest hooks are a
 * (redundant but harmless) earlier fail for the specific commands they cover.
 */
export default function setup(): void {
  const { ok, requiredRange, nodeVersion } = checkNodeVersion();
  if (!ok) {
    throw new Error(
      `Running Node ${nodeVersion}, but this repo requires ${requiredRange} (see .nvmrc / package.json engines). ` +
        "Switch to the pinned Node version (e.g. `nvm use`) before running tests.",
    );
  }
}
