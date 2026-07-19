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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhlY3V0ZS1sb2NhbC13cml0ZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImV4ZWN1dGUtbG9jYWwtd3JpdGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsa0dBQWtHO0FBQ2xHLHFHQUFxRztBQUNyRyx3R0FBd0c7QUFDeEcsb0dBQW9HO0FBQ3BHLGdHQUFnRztBQUNoRywyR0FBMkc7QUFDM0csc0dBQXNHO0FBQ3RHLHdHQUF3RztBQUN4RyxvQkFBb0I7QUFFcEIsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBRzNDLE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDO0FBVW5DLE1BQU0sVUFBVSxpQkFBaUIsQ0FDL0IsSUFBMEIsRUFDMUIsVUFBeUUsRUFBRTtJQUUzRSxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN6QyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUM7SUFDdkMsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFFLE9BQU8sQ0FBQyxTQUFvQixDQUFDLENBQUMsQ0FBQyxrQkFBa0IsQ0FBQztJQUUxRyxPQUFPLElBQUksT0FBTyxDQUEwQixDQUFDLE9BQU8sRUFBRSxFQUFFO1FBQ3RELE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxLQUFLLEVBQUUsQ0FBQyxRQUFRLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNqRyxJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUM7UUFDaEIsSUFBSSxNQUFNLEdBQUcsRUFBRSxDQUFDO1FBQ2hCLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDNUIsS0FBSyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztZQUN0QixPQUFPLENBQUMsRUFBRSxNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDL0UsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBQ2QsS0FBSyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxFQUFFLENBQUMsS0FBYSxFQUFFLEVBQUU7WUFDekMsTUFBTSxJQUFJLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDbkMsQ0FBQyxDQUFDLENBQUM7UUFDSCxLQUFLLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxLQUFhLEVBQUUsRUFBRTtZQUN6QyxNQUFNLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUNuQyxDQUFDLENBQUMsQ0FBQztRQUNILEtBQUssQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLENBQUMsR0FBVSxFQUFFLEVBQUU7WUFDL0Isb0dBQW9HO1lBQ3BHLHlEQUF5RDtZQUN6RCxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDcEIsT0FBTyxDQUFDLEVBQUUsTUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDN0YsQ0FBQyxDQUFDLENBQUM7UUFDSCxLQUFLLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFDLElBQW1CLEVBQUUsRUFBRTtZQUN4QyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDcEIsT0FBTyxDQUFDLEVBQUUsTUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDMUUsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMifQ==