import specJson from "../../public/openapi.json";
import { getApiOrigin } from "./api/origin";

export type Method = "get" | "post" | "put" | "patch" | "delete";

export interface OpenApiParam {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description?: string;
  schema?: { type?: string };
}

export interface OpenApiOperation {
  id: string; // slug for URL: "get-v1-repos"
  operationId?: string;
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  parameters: OpenApiParam[];
  requiresAuth: boolean;
  responses: Record<string, { description?: string; example?: unknown }>;
}

export interface OpenApiTagGroup {
  name: string;
  description?: string;
  operations: OpenApiOperation[];
}

export interface OpenApiSpec {
  title: string;
  version: string;
  description: string;
  servers: Array<{ url: string; description?: string }>;
  tags: OpenApiTagGroup[];
  operations: OpenApiOperation[];
}

type RawResponseContent = Record<
  string,
  { example?: unknown; examples?: Record<string, { value: unknown }> }
>;

interface RawResponse {
  description?: string;
  content?: RawResponseContent;
}

interface RawOperation {
  operationId?: string;
  tags?: string[];
  security?: unknown[];
  summary?: string;
  description?: string;
  parameters?: OpenApiParam[];
  responses?: Record<string, RawResponse>;
}

type RawPathItem = Partial<Record<Method, RawOperation>>;

interface RawOpenApiSpec {
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths?: Record<string, RawPathItem>;
}

const METHODS: Method[] = ["get", "post", "put", "patch", "delete"];

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractExample(content: RawResponseContent | undefined): unknown {
  if (!content) return undefined;
  const json = content["application/json"];
  if (!json) return undefined;
  if (json.example !== undefined) return json.example;
  if (json.examples) {
    const first = Object.values(json.examples)[0];
    return first?.value;
  }
  return undefined;
}

function extractPathParams(path: string, declared: OpenApiParam[]): OpenApiParam[] {
  const declaredKeys = new Set(declared.map((p) => `${p.in}:${p.name}`));
  const names = Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1]).filter(Boolean);
  return names
    .filter((name) => !declaredKeys.has(`path:${name}`))
    .map((name) => ({
      name,
      in: "path" as const,
      required: true,
      description: `Value for {${name}} in ${path}.`,
      schema: { type: "string" },
    }));
}

function build(): OpenApiSpec {
  const raw = specJson as RawOpenApiSpec;
  const ops: OpenApiOperation[] = [];
  const paths = raw.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const tag = (op.tags && op.tags[0]) || "Other";
      const requiresAuth = requiresAuthentication(path, op);
      const declaredParams = (op.parameters ?? []) as OpenApiParam[];
      const responses: OpenApiOperation["responses"] = {};
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        responses[code] = {
          description: r.description,
          example: extractExample(r.content),
        };
      }
      ops.push({
        id: slugify(`${method}-${path}`),
        operationId: op.operationId,
        method,
        path,
        tag,
        summary: op.summary ?? `${method.toUpperCase()} ${path}`,
        description: op.description,
        parameters: [...extractPathParams(path, declaredParams), ...declaredParams],
        requiresAuth,
        responses,
      });
    }
  }

  const tagsRaw = (raw.tags ?? []) as Array<{ name: string; description?: string }>;
  const tags: OpenApiTagGroup[] = tagsRaw.map((t) => ({
    name: t.name,
    description: t.description,
    operations: ops.filter((o) => o.tag === t.name),
  }));
  // Add any tag groups not declared
  for (const op of ops) {
    if (!tags.find((t) => t.name === op.tag)) {
      tags.push({ name: op.tag, operations: ops.filter((o) => o.tag === op.tag) });
    }
  }

  return {
    title: raw.info?.title ?? "API",
    version: raw.info?.version ?? "",
    description: raw.info?.description ?? "",
    servers: normalizeServers(raw.servers),
    tags,
    operations: ops,
  };
}

export const openapi: OpenApiSpec = build();

function requiresAuthentication(path: string, op: RawOperation): boolean {
  if (Array.isArray(op.security)) return op.security.length > 0;
  return false;
}

function normalizeServers(servers: Array<{ url: string; description?: string }> | undefined) {
  const apiOrigin = getApiOrigin();
  if (!servers || servers.length === 0) return [{ url: apiOrigin, description: "Production" }];
  return servers.map((server, index) => (index === 0 ? { ...server, url: apiOrigin } : server));
}

export function findOperation(id: string): OpenApiOperation | undefined {
  return openapi.operations.find((o) => o.id === id);
}

export function generateCurl(op: OpenApiOperation, server: string, token?: string): string {
  const url = server.replace(/\/$/, "") + op.path;
  const lines = [`curl -X ${op.method.toUpperCase()} '${url}' \\`];
  if (op.requiresAuth) {
    lines.push(`  -H 'Authorization: Bearer ${token ? token : "$GITTENSORY_TOKEN"}' \\`);
  }
  lines.push(`  -H 'Accept: application/json'`);
  if (op.method !== "get" && op.method !== "delete") {
    lines[lines.length - 1] += ` \\`;
    lines.push(`  -d '{}'`);
  }
  return lines.join("\n");
}

export function generateFetch(op: OpenApiOperation, server: string): string {
  const url = server.replace(/\/$/, "") + op.path;
  const headers = ["'Accept': 'application/json'"];
  if (op.requiresAuth) headers.push("'Authorization': `Bearer ${token}`");
  const init: string[] = [
    `  method: '${op.method.toUpperCase()}'`,
    `  headers: { ${headers.join(", ")} }`,
  ];
  if (op.method !== "get" && op.method !== "delete") init.push("  body: JSON.stringify({})");
  return `const res = await fetch('${url}', {\n${init.join(",\n")},\n});\nconst data = await res.json();`;
}

export function generatePython(op: OpenApiOperation, server: string): string {
  const url = server.replace(/\/$/, "") + op.path;
  const headers = ["'Accept': 'application/json'"];
  if (op.requiresAuth) headers.push("'Authorization': f'Bearer {token}'");
  const args = [`'${url}'`, `headers={${headers.join(", ")}}`];
  if (op.method !== "get" && op.method !== "delete") args.push("json={}");
  return `import httpx\n\nres = httpx.${op.method}(${args.join(", ")})\ndata = res.json()`;
}
