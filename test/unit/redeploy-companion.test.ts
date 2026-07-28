import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { handleConnection, runDeploy, rotateSecret } from "../../scripts/redeploy-companion";

const TOKEN = "companion-test-token";

function fakeChildProcess(): { child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }; emitClose: (code: number | null) => void; emitError: (error: Error) => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return {
    child,
    emitClose: (code) => child.emit("close", code),
    emitError: (error) => child.emit("error", error),
  };
}

describe("runDeploy (#7723)", () => {
  it("spawns bash scripts/deploy-selfhost-image.sh with no args when no image is given, forwards stdout/stderr lines, and resolves ok on exit 0", async () => {
    const { child, emitClose } = fakeChildProcess();
    const spawnSpy = vi.fn().mockReturnValue(child);
    const logs: string[] = [];

    const resultPromise = runDeploy(undefined, (line) => logs.push(line), spawnSpy as never);
    expect(spawnSpy).toHaveBeenCalledExactlyOnceWith("bash", ["scripts/deploy-selfhost-image.sh"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
    child.stdout.emit("data", Buffer.from("selfhost image deploy: pulling ghcr.io/jsonbored/loopover-selfhost:latest\n"));
    child.stderr.emit("data", Buffer.from("some warning\n"));
    emitClose(0);

    const result = await resultPromise;
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(logs).toEqual(["selfhost image deploy: pulling ghcr.io/jsonbored/loopover-selfhost:latest", "some warning"]);
  });

  it("passes the image as a single argv element when given -- never shell-interpolated", async () => {
    const { child, emitClose } = fakeChildProcess();
    const spawnSpy = vi.fn().mockReturnValue(child);

    const resultPromise = runDeploy("ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0", () => undefined, spawnSpy as never);
    expect(spawnSpy).toHaveBeenCalledExactlyOnceWith(
      "bash",
      ["scripts/deploy-selfhost-image.sh", "ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0"],
      expect.anything(),
    );
    emitClose(0);
    await resultPromise;
  });

  it("resolves ok:false with the real exit code on a non-zero exit", async () => {
    const { child, emitClose } = fakeChildProcess();
    const resultPromise = runDeploy(undefined, () => undefined, (() => child) as never);
    emitClose(1);
    expect(await resultPromise).toEqual({ ok: false, exitCode: 1 });
  });

  it("resolves ok:false with the spawn error's message when the process itself fails to start", async () => {
    const { child, emitError } = fakeChildProcess();
    const resultPromise = runDeploy(undefined, () => undefined, (() => child) as never);
    emitError(new Error("bash: not found"));
    expect(await resultPromise).toEqual({ ok: false, exitCode: null, error: "bash: not found" });
  });

  it("drops blank lines from stdout/stderr chunks -- only non-empty lines reach onLog", async () => {
    const { child, emitClose } = fakeChildProcess();
    const logs: string[] = [];
    const resultPromise = runDeploy(undefined, (line) => logs.push(line), (() => child) as never);
    child.stdout.emit("data", Buffer.from("real line\n\n   \nanother real line\n"));
    emitClose(0);
    await resultPromise;
    expect(logs).toEqual(["real line", "another real line"]);
  });
});

describe("handleConnection (#7723)", () => {
  const fakeDeploy = (result: Awaited<ReturnType<typeof runDeploy>>) =>
    vi.fn().mockImplementation(async (_image: string | undefined, onLog: (line: string) => void) => {
      onLog("deploying...");
      return result;
    });

  it("rejects a malformed (non-JSON) request line as unauthorized without ever touching busy state or deploy", async () => {
    const setBusy = vi.fn();
    const written: string[] = [];
    const deploy = vi.fn();

    await handleConnection(TOKEN, "not json", () => false, setBusy, (line) => written.push(line), deploy);

    expect(written).toEqual([JSON.stringify({ ok: false, error: "unauthorized" })]);
    expect(setBusy).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it("rejects a missing token as unauthorized", async () => {
    const written: string[] = [];
    await handleConnection(TOKEN, JSON.stringify({}), () => false, vi.fn(), (line) => written.push(line), vi.fn());
    expect(written).toEqual([JSON.stringify({ ok: false, error: "unauthorized" })]);
  });

  it("rejects a wrong token as unauthorized (not a partial/prefix match)", async () => {
    const written: string[] = [];
    await handleConnection(
      TOKEN,
      JSON.stringify({ token: `${TOKEN}-wrong` }),
      () => false,
      vi.fn(),
      (line) => written.push(line),
      vi.fn(),
    );
    expect(written).toEqual([JSON.stringify({ ok: false, error: "unauthorized" })]);
  });

  it("rejects a request while a redeploy is already in progress, without calling deploy again", async () => {
    const written: string[] = [];
    const deploy = vi.fn();
    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN }), () => true, vi.fn(), (line) => written.push(line), deploy);
    expect(written).toEqual([JSON.stringify({ ok: false, error: "redeploy_already_in_progress" })]);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("rejects an unsafe image override (whitespace/quote/backslash/compose-interpolation chars) before ever calling deploy", async () => {
    const written: string[] = [];
    const deploy = vi.fn();
    await handleConnection(
      TOKEN,
      JSON.stringify({ token: TOKEN, image: "not a valid $(image)" }),
      () => false,
      vi.fn(),
      (line) => written.push(line),
      deploy,
    );
    expect(written).toEqual([JSON.stringify({ ok: false, error: "invalid_image_override" })]);
    expect(deploy).not.toHaveBeenCalled();
  });

  it.each(["has`a`backtick", "has;a;semicolon", "has|a|pipe", "has&an&ampersand", "has<a>anglebracket"])(
    "rejects shell metacharacters in an image override: %s",
    async (image) => {
      const written: string[] = [];
      const deploy = vi.fn();
      await handleConnection(TOKEN, JSON.stringify({ token: TOKEN, image }), () => false, vi.fn(), (line) => written.push(line), deploy);
      expect(written).toEqual([JSON.stringify({ ok: false, error: "invalid_image_override" })]);
      expect(deploy).not.toHaveBeenCalled();
    },
  );

  it("accepts a legitimate image reference with no false-positive rejection", async () => {
    const written: string[] = [];
    const deploy = vi.fn().mockImplementation(async () => ({ ok: true, exitCode: 0 }));
    await handleConnection(
      TOKEN,
      JSON.stringify({ token: TOKEN, image: "ghcr.io/jsonbored/loopover-selfhost@sha256:abcdef0123456789" }),
      () => false,
      vi.fn(),
      (line) => written.push(line),
      deploy,
    );
    expect(deploy).toHaveBeenCalledExactlyOnceWith("ghcr.io/jsonbored/loopover-selfhost@sha256:abcdef0123456789", expect.any(Function));
  });

  it("runs a valid authenticated request end to end: sets busy, streams logs, writes the terminal result, clears busy", async () => {
    const written: string[] = [];
    const busyStates: boolean[] = [];
    let busy = false;
    const deploy = fakeDeploy({ ok: true, exitCode: 0 });

    await handleConnection(
      TOKEN,
      JSON.stringify({ token: TOKEN, image: "ghcr.io/jsonbored/loopover-selfhost:latest" }),
      () => busy,
      (value) => {
        busy = value;
        busyStates.push(value);
      },
      (line) => written.push(line),
      deploy,
    );

    expect(deploy).toHaveBeenCalledExactlyOnceWith("ghcr.io/jsonbored/loopover-selfhost:latest", expect.any(Function));
    expect(written).toEqual([JSON.stringify({ log: "deploying..." }), JSON.stringify({ ok: true, exitCode: 0 })]);
    expect(busyStates).toEqual([true, false]); // set busy before deploying, cleared after -- in that order
  });

  it("clears busy even when the underlying deploy call throws -- never leaves the companion permanently locked", async () => {
    let busy = false;
    const deploy = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      handleConnection(
        TOKEN,
        JSON.stringify({ token: TOKEN }),
        () => busy,
        (value) => {
          busy = value;
        },
        () => undefined,
        deploy,
      ),
    ).rejects.toThrow("boom");
    expect(busy).toBe(false);
  });

  it("includes the error field in the terminal response when the deploy result carries one", async () => {
    const written: string[] = [];
    const deploy = fakeDeploy({ ok: false, exitCode: null, error: "bash: not found" });

    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN }), () => false, vi.fn(), (line) => written.push(line), deploy);

    expect(written[1]).toBe(JSON.stringify({ ok: false, exitCode: null, error: "bash: not found" }));
  });
});

describe("rotateSecret (#9543 — the two silent footguns this exists to prevent)", () => {
  const io = (overrides: Partial<Parameters<typeof rotateSecret>[2]> = {}) => {
    const writes: Array<{ path: string; data: string; mode: number | undefined }> = [];
    return {
      writes,
      io: {
        readFileSync: (() => "previous-value") as never,
        writeFileSync: ((path: string, data: string, opts?: { mode?: number }) => {
          writes.push({ path, data, mode: opts?.mode });
        }) as never,
        existsSync: (() => true) as never,
        chmodSync: (() => undefined) as never,
        now: () => new Date("2026-07-28T00:00:00.000Z"),
        ...overrides,
      },
    };
  };

  it("rejects an unknown secret name rather than writing an arbitrary path", () => {
    const { io: fake, writes } = io();
    expect(rotateSecret("../../etc/passwd", "x", fake)).toEqual({ ok: false, error: "unknown_secret" });
    expect(writes).toHaveLength(0);
  });

  it("rejects a non-string secret name", () => {
    expect(rotateSecret(42, "x", io().io)).toEqual({ ok: false, error: "unknown_secret" });
  });

  it("REGRESSION: rejects a value with a comment/label line above it", () => {
    // The exact shape that silently became part of the credential in production: the loader only trims,
    // so both lines would have been sent to the CLI as one token and every AI call would fail auth.
    const { io: fake, writes } = io();
    expect(rotateSecret("claude_code_oauth_token", "# some-account\nsk-ant-oat01-real", fake)).toEqual({ ok: false, error: "invalid_secret_value" });
    expect(writes).toHaveLength(0);
  });

  it("rejects a value that is itself a comment, is empty, is padded, or is oversized", () => {
    const { io: fake } = io();
    for (const bad of ["#sk-ant-x", "", "  sk-ant-x", "sk-ant-x  ", "sk-ant-x\r\n", "x".repeat(4097)]) {
      expect(rotateSecret("claude_code_oauth_token", bad, fake)).toEqual({ ok: false, error: "invalid_secret_value" });
    }
  });

  it("rejects a non-string value", () => {
    expect(rotateSecret("claude_code_oauth_token", { token: "x" }, io().io)).toEqual({ ok: false, error: "invalid_secret_value" });
  });

  it("writes the bare value with no trailing newline, at 0644, and backs up the previous value first", () => {
    const { io: fake, writes } = io();
    const result = rotateSecret("claude_code_oauth_token", "sk-ant-oat01-new", fake);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toContain(".deploy-backups/claude_code_oauth_token.txt.bak-");
    // Backup first (mode 600), then the in-place write of the bare value (mode 644).
    expect(writes[0]!.data).toBe("previous-value");
    expect(writes[0]!.mode).toBe(0o600);
    expect(writes[1]!.data).toBe("sk-ant-oat01-new");
    expect(writes[1]!.mode).toBe(0o644);
    expect(writes[1]!.path).toContain("secrets/claude_code_oauth_token.txt");
  });

  it("skips the backup when no prior value exists", () => {
    const { io: fake, writes } = io({ existsSync: (() => false) as never });
    expect(rotateSecret("claude_code_oauth_token", "sk-ant-first", fake)).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data).toBe("sk-ant-first");
  });

  it("reports a write failure instead of throwing", () => {
    const { io: fake } = io({
      writeFileSync: (() => {
        throw new Error("EACCES: permission denied");
      }) as never,
    });
    expect(rotateSecret("claude_code_oauth_token", "sk-ant-x", fake)).toEqual({ ok: false, error: "EACCES: permission denied" });
  });

  it("accepts every allowlisted secret name", () => {
    const { io: fake } = io();
    for (const name of ["claude_code_oauth_token", "github_webhook_secret", "loopover_api_token", "loopover_mcp_token", "loopover_mcp_admin_token", "pagerduty_routing_key"]) {
      expect(rotateSecret(name, "some-value", fake).ok).toBe(true);
    }
  });
});

describe("handleConnection verb dispatch (#9543)", () => {
  const collect = () => {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line) };
  };

  it("routes a rotate-secret request to the rotator, not the deployer", async () => {
    const { lines, write } = collect();
    const deploy = vi.fn();
    const rotate = vi.fn(() => ({ ok: true, backupPath: "/b" }));
    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN, action: "rotate-secret", secret: "claude_code_oauth_token", value: "sk-ant-x" }), () => false, () => {}, write, deploy as never, rotate as never);
    expect(deploy).not.toHaveBeenCalled();
    expect(rotate).toHaveBeenCalledWith("claude_code_oauth_token", "sk-ant-x");
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, backupPath: "/b" });
  });

  it("serves a rotation even while a redeploy is in progress", async () => {
    // A 15-minute redeploy is exactly when an operator is most likely to need a credential fixed, and a
    // single truncating write races nothing that the deploy is doing.
    const { lines, write } = collect();
    const rotate = vi.fn(() => ({ ok: true }));
    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN, action: "rotate-secret", secret: "claude_code_oauth_token", value: "v" }), () => true, () => {}, write, vi.fn() as never, rotate as never);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true });
  });

  it("rejects a rotation with a bad token before reaching the rotator", async () => {
    const { lines, write } = collect();
    const rotate = vi.fn();
    await handleConnection(TOKEN, JSON.stringify({ token: "wrong", action: "rotate-secret", secret: "claude_code_oauth_token", value: "v" }), () => false, () => {}, write, vi.fn() as never, rotate as never);
    expect(rotate).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0]!)).toEqual({ ok: false, error: "unauthorized" });
  });

  it("rejects an unrecognised action", async () => {
    const { lines, write } = collect();
    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN, action: "rm-rf" }), () => false, () => {}, write, vi.fn() as never, vi.fn() as never);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: false, error: "unknown_action" });
  });

  it("BACKWARD COMPAT: a request with no action still redeploys", async () => {
    // The app container and the host companion upgrade independently, so a new companion must keep
    // serving an old client that has never heard of `action`.
    const { lines, write } = collect();
    const deploy = vi.fn(async () => ({ ok: true, exitCode: 0 }));
    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN }), () => false, () => {}, write, deploy as never, vi.fn() as never);
    expect(deploy).toHaveBeenCalled();
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, exitCode: 0 });
  });

  it("an explicit action of redeploy behaves identically", async () => {
    const { lines, write } = collect();
    const deploy = vi.fn(async () => ({ ok: true, exitCode: 0 }));
    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN, action: "redeploy" }), () => false, () => {}, write, deploy as never, vi.fn() as never);
    expect(deploy).toHaveBeenCalled();
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, exitCode: 0 });
  });
});
