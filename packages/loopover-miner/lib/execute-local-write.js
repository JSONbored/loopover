// Real executeLocalWrite implementation (#5132, Wave 3.5). Mirrors coding-agent-construction.js's
// createRealCliSubprocessSpawn pattern (real child_process, resolve-not-reject on error/timeout so a
// killed/errored process's partial output -- e.g. an auth failure line on stderr -- is never lost to an
// unhandled rejection) but for LocalWriteActionSpec.command: a single shell-safe string (built with
// packages/loopover-engine/src/miner/local-write-tools.ts's own single-quote escaping), not the
// cmd/args-array CliSubprocessSpawnFn contract the coding-agent driver itself uses. Runs it via `sh -c` in
// the given working directory. Per local-write-tools.ts's own boundary comment, this always runs with
// whatever `gh`/`git` credentials are already configured in that environment -- loopover never performs
// the write itself.
import { spawn } from "node:child_process";
const DEFAULT_TIMEOUT_MS = 120_000;
export function executeLocalWrite(spec, options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
        const child = spawn("sh", ["-c", spec.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ action: spec.action, stdout, stderr, code: null, timedOut: true });
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            // A spawn-level error (e.g. no `sh` on PATH) fires before the child ever produces output -- mirrors
            // createRealCliSubprocessSpawn's own identical handling.
            clearTimeout(timer);
            resolve({ action: spec.action, stdout, stderr: err.message, code: null, timedOut: false });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ action: spec.action, stdout, stderr, code, timedOut: false });
        });
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhlY3V0ZS1sb2NhbC13cml0ZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImV4ZWN1dGUtbG9jYWwtd3JpdGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsa0dBQWtHO0FBQ2xHLHFHQUFxRztBQUNyRyx3R0FBd0c7QUFDeEcsb0dBQW9HO0FBQ3BHLGdHQUFnRztBQUNoRywyR0FBMkc7QUFDM0csc0dBQXNHO0FBQ3RHLHdHQUF3RztBQUN4RyxvQkFBb0I7QUFFcEIsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBWTNDLE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDO0FBRW5DLE1BQU0sVUFBVSxpQkFBaUIsQ0FDL0IsSUFBMEIsRUFDMUIsVUFBeUUsRUFBRTtJQUUzRSxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN6QyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUM7SUFDdkMsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLGtCQUFrQixDQUFDO0lBRTlGLE9BQU8sSUFBSSxPQUFPLENBQTBCLENBQUMsT0FBTyxFQUFFLEVBQUU7UUFDdEQsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLEVBQUUsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEtBQUssRUFBRSxDQUFDLFFBQVEsRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ2pHLElBQUksTUFBTSxHQUFHLEVBQUUsQ0FBQztRQUNoQixJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUM7UUFDaEIsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUM1QixLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ3RCLE9BQU8sQ0FBQyxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUMvRSxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDZCxLQUFLLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxLQUFhLEVBQUUsRUFBRTtZQUN6QyxNQUFNLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUNuQyxDQUFDLENBQUMsQ0FBQztRQUNILEtBQUssQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sRUFBRSxDQUFDLEtBQWEsRUFBRSxFQUFFO1lBQ3pDLE1BQU0sSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ25DLENBQUMsQ0FBQyxDQUFDO1FBQ0gsS0FBSyxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxHQUFVLEVBQUUsRUFBRTtZQUMvQixvR0FBb0c7WUFDcEcseURBQXlEO1lBQ3pELFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNwQixPQUFPLENBQUMsRUFBRSxNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsQ0FBQyxPQUFPLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztRQUM3RixDQUFDLENBQUMsQ0FBQztRQUNILEtBQUssQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLENBQUMsSUFBbUIsRUFBRSxFQUFFO1lBQ3hDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNwQixPQUFPLENBQUMsRUFBRSxNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztRQUMxRSxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyJ9