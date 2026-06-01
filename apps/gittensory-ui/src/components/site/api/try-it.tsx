import { Eye, EyeOff, Key, Loader2, Play, RefreshCw, Trash2, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { Callout } from "@/components/site/primitives";
import { StatusPill } from "@/components/site/control-primitives";
import type { OpenApiOperation } from "@/lib/openapi";
import { notifyApiFailure } from "@/lib/api/request";
import {
  beginRequest,
  endRequest,
  pingHealth,
  reportApiFailure,
  reportApiOk,
  useApiStatus,
} from "@/lib/api/status";

const STORAGE_KEY = "gittensory.session_token";

interface Result {
  status: number;
  statusText: string;
  durationMs: number;
  body: string;
}

function isJsonContentType(ct: string | null) {
  return !!ct && /(application|text)\/(json|.*\+json)/i.test(ct);
}

export function TryIt({ op, server }: { op: OpenApiOperation; server: string }) {
  const { status, connection } = useApiStatus();
  const offline = connection === "offline";
  const apiBlocked = status === "unreachable" || status === "timeout";
  const disabledReason = offline
    ? "Offline — actions paused"
    : apiBlocked
      ? status === "unreachable"
        ? "API unreachable — actions paused"
        : "API timing out — actions paused"
      : null;

  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [pathParams, setPathParams] = useState<Record<string, string>>({});
  const [queryParams, setQueryParams] = useState<Record<string, string>>({});
  const [body, setBody] = useState("{\n  \n}");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    setToken(localStorage.getItem(STORAGE_KEY) ?? "");
    setResult(null);
    setError(null);
    setPathParams({});
    setQueryParams({});
  }, [op.id]);

  const saveToken = (v: string) => {
    setToken(v);
    if (v) {
      localStorage.setItem(STORAGE_KEY, v);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      toast("Token cleared from this browser");
    }
  };

  const hasBody = op.method !== "get" && op.method !== "delete";

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    beginRequest();
    const label = `${op.method.toUpperCase()} ${op.path}`;
    try {
      let path = op.path;
      for (const p of op.parameters.filter((x) => x.in === "path")) {
        const v = pathParams[p.name] ?? "";
        if (!v) throw new Error(`Path param "${p.name}" is required`);
        path = path.replace(`{${p.name}}`, encodeURIComponent(v));
      }
      const qs = Object.entries(queryParams)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const url = server.replace(/\/$/, "") + path + (qs ? `?${qs}` : "");
      const headers: Record<string, string> = { Accept: "application/json" };
      if (op.requiresAuth && token) headers.Authorization = `Bearer ${token}`;
      const init: RequestInit = {
        method: op.method.toUpperCase(),
        headers,
        credentials: "include",
      };
      if (hasBody) {
        headers["Content-Type"] = "application/json";
        init.body = body;
      }
      const t0 = performance.now();
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      const ct = res.headers.get("content-type");
      const text = await res.text();
      let pretty = text;
      if (isJsonContentType(ct)) {
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* noop */
        }
      }
      const durationMs = Math.round(performance.now() - t0);
      setResult({
        status: res.status,
        statusText: res.statusText,
        durationMs,
        body: pretty,
      });
      if (res.ok) {
        reportApiOk();
        toast.success(`${res.status} ${res.statusText} · ${durationMs}ms`, {
          id: `tryit:${label}`,
        });
      } else {
        if (res.status >= 500) {
          reportApiFailure("degraded", `${res.status} ${res.statusText}`);
        }
        notifyApiFailure({
          label,
          kind: "http",
          status: res.status,
          message: `${res.status} ${res.statusText}`,
          retry: () => runRef.current(),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      setError(msg);
      notifyApiFailure({
        label,
        kind: isAbort ? "timeout" : "network",
        message: msg,
        retry: () => runRef.current(),
      });
    } finally {
      setBusy(false);
      endRequest();
    }
  }, [body, hasBody, op, pathParams, queryParams, server, token]);

  // Keep retry callback stable across renders.
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const pathParamList = op.parameters.filter((p) => p.in === "path");
  const queryParamList = op.parameters.filter((p) => p.in === "query");

  return (
    <div className="space-y-4">
      {op.requiresAuth && (
        <div className="flex items-center gap-2 rounded-token border border-border bg-transparent p-2">
          <Key className="ml-1 size-4 text-mint" />
          <input
            type={show ? "text" : "password"}
            value={token}
            onChange={(e) => saveToken(e.target.value)}
            placeholder="Gittensory session token"
            className="flex-1 bg-transparent px-1 py-1 font-mono text-token-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="rounded-token p-1.5 text-muted-foreground hover:text-foreground"
            aria-label="Toggle visibility"
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => saveToken("")}
            className="rounded-token p-1.5 text-muted-foreground hover:text-danger"
            aria-label="Clear token"
            title="Clear token"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      )}

      {(pathParamList.length > 0 || queryParamList.length > 0) && (
        <div className="space-y-2">
          {pathParamList.map((p) => (
            <ParamInput
              key={`p-${p.name}`}
              kind="path"
              name={p.name}
              required={p.required}
              value={pathParams[p.name] ?? ""}
              onChange={(v) => setPathParams((s) => ({ ...s, [p.name]: v }))}
            />
          ))}
          {queryParamList.map((p) => (
            <ParamInput
              key={`q-${p.name}`}
              kind="query"
              name={p.name}
              required={p.required}
              value={queryParams[p.name] ?? ""}
              onChange={(v) => setQueryParams((s) => ({ ...s, [p.name]: v }))}
            />
          ))}
        </div>
      )}

      {hasBody && (
        <div>
          <div className="mb-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Request body (JSON)
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full rounded-token border border-border bg-[oklch(0.13_0.005_260)] p-3 font-mono text-[12px] text-foreground focus:border-mint/40 focus:outline-none"
          />
        </div>
      )}

      <button
        type="button"
        onClick={run}
        disabled={busy || offline || apiBlocked}
        title={disabledReason ?? undefined}
        className="inline-flex w-full items-center justify-center gap-2 rounded-token bg-mint px-3 py-2 text-token-xs font-medium text-primary-foreground transition-[filter,opacity] duration-150 hover:brightness-110 disabled:opacity-60 focus-ring motion-reduce:transition-none"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : disabledReason ? (
          offline ? (
            <WifiOff className="size-3.5" />
          ) : (
            <Loader2 className="size-3.5 opacity-60" />
          )
        ) : (
          <Play className="size-3.5" />
        )}
        {busy ? "Sending…" : (disabledReason ?? "Send request")}
      </button>

      {disabledReason && (
        <Callout variant="safety">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {offline
                ? "You're offline. Live API calls are paused until your connection returns."
                : "The Gittensory API isn't responding. We've paused live calls until it's back."}{" "}
              <Link
                to="/docs/troubleshooting"
                hash="api-status"
                className="underline-offset-2 hover:underline"
              >
                See troubleshooting →
              </Link>
            </span>
            {!offline && (
              <button
                type="button"
                onClick={() => {
                  toast("Rechecking API…", {
                    id: "api:recheck",
                    description: "Pinging /health now.",
                  });
                  void pingHealth(true);
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-token border border-border bg-transparent px-2 text-token-2xs font-medium text-foreground transition-all duration-150 hover:bg-accent focus-ring motion-reduce:transition-none"
              >
                <RefreshCw className="size-3" aria-hidden />
                Recheck now
              </button>
            )}
          </div>
        </Callout>
      )}

      {op.requiresAuth && !token && (
        <Callout variant="safety">
          <strong>No PATs.</strong> Signed-in browsers use the HttpOnly session cookie. Paste a
          Gittensory token from <code>gittensory-mcp login</code> only for manual bearer testing.
        </Callout>
      )}

      {error && (
        <div className="rounded-token border border-danger/40 bg-danger/10 p-3 text-token-xs text-danger">
          {error}
        </div>
      )}

      {result && (
        <div className="overflow-hidden rounded-token border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-transparent px-3 py-2">
            <div className="flex items-center gap-2">
              <StatusPill
                status={result.status < 400 ? "ok" : result.status < 500 ? "warn" : "blocked"}
              >
                {result.status} {result.statusText}
              </StatusPill>
              <span className="font-mono text-token-2xs text-muted-foreground">
                {result.durationMs}ms
              </span>
            </div>
          </div>
          <pre className="scrollbar-none max-h-80 overflow-auto bg-[oklch(0.13_0.005_260)] p-3 font-mono text-[12px] leading-token-relaxed text-foreground/90">
            <code>{result.body}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

function ParamInput({
  kind,
  name,
  required,
  value,
  onChange,
}: {
  kind: "path" | "query";
  name: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-token border border-border bg-transparent px-2 py-1.5">
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {kind}
      </span>
      <span className="font-mono text-[11.5px] text-foreground/90">
        {name}
        {required && <span className="text-danger">*</span>}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="flex-1 bg-transparent px-1 py-0.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        placeholder={`value`}
      />
    </label>
  );
}
