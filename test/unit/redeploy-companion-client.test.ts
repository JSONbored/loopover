import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { triggerRedeploy } from "../../src/selfhost/redeploy-companion-client";

// Real Unix domain sockets, not a mocked node:net -- this is the exact protocol
// scripts/redeploy-companion.ts's own server speaks, so a fake with the wrong shape would prove nothing about
// real interop between the two. Both sides of the wire are exercised: this file plays the SERVER role with a
// scripted response, triggerRedeploy is the real CLIENT under test.

let server: Server | null = null;
let root: string | null = null;

afterEach(() => {
  server?.close();
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function startFakeCompanion(
  onRequest: (requestLine: string, write: (line: string) => void, end: () => void, rawWrite: (chunk: string) => void) => void,
): string {
  root = mkdtempSync(join(tmpdir(), "loopover-redeploy-client-test-"));
  const socketPath = join(root, "companion.sock");
  server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      onRequest(
        line,
        (out) => socket.write(`${out}\n`),
        () => socket.end(),
        (raw) => socket.write(raw),
      );
    });
  });
  server.listen(socketPath);
  return socketPath;
}

function waitForListening(): Promise<void> {
  return new Promise((resolve) => server!.once("listening", resolve));
}

describe("triggerRedeploy (#7723)", () => {
  it("sends the token and image in one request line, collects streamed log lines, and resolves the terminal result", async () => {
    const socketPath = startFakeCompanion((requestLine, write, end) => {
      expect(JSON.parse(requestLine)).toEqual({ token: "test-token", image: "ghcr.io/jsonbored/loopover-selfhost:latest" });
      write(JSON.stringify({ log: "pulling..." }));
      write(JSON.stringify({ log: "restarting..." }));
      write(JSON.stringify({ ok: true, exitCode: 0 }));
      end();
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, "ghcr.io/jsonbored/loopover-selfhost:latest");

    expect(result).toEqual({ ok: true, exitCode: 0, log: ["pulling...", "restarting..."] });
  });

  it("omits the image key entirely from the request when none is given", async () => {
    const socketPath = startFakeCompanion((requestLine, write, end) => {
      expect(JSON.parse(requestLine)).toEqual({ token: "test-token" });
      write(JSON.stringify({ ok: true, exitCode: 0 }));
      end();
    });
    await waitForListening();

    await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
  });

  it("carries the error field through when the terminal result has one", async () => {
    const socketPath = startFakeCompanion((_line, write, end) => {
      write(JSON.stringify({ ok: false, exitCode: 1, error: "health check timed out" }));
      end();
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
    expect(result).toEqual({ ok: false, exitCode: 1, error: "health check timed out", log: [] });
  });

  it("defaults a missing exitCode in the terminal line to null", async () => {
    const socketPath = startFakeCompanion((_line, write, end) => {
      write(JSON.stringify({ ok: false }));
      end();
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
    expect(result.exitCode).toBeNull();
  });

  it("drops a malformed (non-JSON) line from the server instead of treating it as terminal", async () => {
    const socketPath = startFakeCompanion((_line, write, end) => {
      write("not valid json");
      write(JSON.stringify({ ok: true, exitCode: 0 }));
      end();
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
    expect(result).toEqual({ ok: true, exitCode: 0, log: [] });
  });

  it("rejects when the companion closes the connection without ever sending a terminal response", async () => {
    const socketPath = startFakeCompanion((_line, _write, end) => {
      end(); // closes immediately, no terminal `ok` line
    });
    await waitForListening();

    await expect(triggerRedeploy({ socketPath, token: "test-token" }, undefined)).rejects.toThrow(
      "redeploy companion closed the connection before sending a terminal response",
    );
  });

  it("skips a JSON line that parses successfully but is not an object (e.g. a bare number) -- neither log nor terminal shaped", async () => {
    const socketPath = startFakeCompanion((_line, write, end) => {
      write("42"); // valid JSON, but typeof 42 !== "object" -- distinct from the malformed-JSON case above
      write(JSON.stringify({ ok: true, exitCode: 0 }));
      end();
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
    expect(result).toEqual({ ok: true, exitCode: 0, log: [] });
  });

  it("skips a blank line from the server without treating it as malformed or terminal", async () => {
    const socketPath = startFakeCompanion((_line, write, end, rawWrite) => {
      rawWrite("\n"); // an entirely blank line -- distinct from the malformed-JSON case above
      write(JSON.stringify({ ok: true, exitCode: 0 }));
      end();
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
    expect(result).toEqual({ ok: true, exitCode: 0, log: [] });
  });

  it("ignores a second terminal-shaped line arriving after the first already resolved the promise", async () => {
    const socketPath = startFakeCompanion((_line, write, end) => {
      write(JSON.stringify({ ok: true, exitCode: 0 }));
      write(JSON.stringify({ ok: false, exitCode: 1, error: "should never be observed" }));
      end();
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
    expect(result).toEqual({ ok: true, exitCode: 0, log: [] }); // the FIRST terminal line wins, not the second
  });

  it("rejects when no companion is listening at the configured socket path", async () => {
    root = mkdtempSync(join(tmpdir(), "loopover-redeploy-client-test-"));
    const socketPath = join(root, "nothing-here.sock");

    await expect(triggerRedeploy({ socketPath, token: "test-token" }, undefined)).rejects.toThrow();
  });

  it("rejects with a timeout error when the companion accepts the connection but never responds", async () => {
    const socketPath = startFakeCompanion(() => undefined); // accepts, reads the request, never writes back
    await waitForListening();

    await expect(triggerRedeploy({ socketPath, token: "test-token", timeoutMs: 20 }, undefined)).rejects.toThrow(/did not respond within 20ms/);
  });

  it("buffers a terminal line split across multiple raw socket writes (no newline in the first write at all)", async () => {
    const socketPath = startFakeCompanion((_line, _write, end, rawWrite) => {
      const fullLine = JSON.stringify({ ok: true, exitCode: 0 });
      const midpoint = Math.floor(fullLine.length / 2);
      rawWrite(fullLine.slice(0, midpoint)); // no newline -- the client must NOT treat this as a complete line
      setTimeout(() => {
        rawWrite(`${fullLine.slice(midpoint)}\n`);
        end();
      }, 5);
    });
    await waitForListening();

    const result = await triggerRedeploy({ socketPath, token: "test-token" }, undefined);
    expect(result).toEqual({ ok: true, exitCode: 0, log: [] });
  });
});
