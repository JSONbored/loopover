// Public OAuth draft-submission flow (GITTENSORY_REVIEW_DRAFT), ported faithfully from reviewbot
// (src/core/draft.ts + the fork-PR / OAuth-exchange primitives from src/core/github.ts).
//
//   POST /v1/drafts                -> store draft + return a GitHub OAuth authorize URL
//   GET  /v1/drafts/:id            -> redacted draft status
//   GET  /v1/drafts/auth/callback  -> exchange code, encrypt+store the user token, queue submit-draft
//   queue submit-draft             -> fork the upstream repo with the user's token + open the content PR
//
// Single-tenant (gittensory is one worker): the per-project `slug`/`AgentConfig` partitioning from
// reviewbot is collapsed into module constants + env vars. The flow is gated by GITTENSORY_REVIEW_DRAFT; when
// the flag is off the router never mounts these handlers (callers see 404).
import { decryptDraftToken, encryptDraftToken, newDraftId, randomDraftToken, sha256Hex, timingSafeEqualHex } from "../utils/crypto";

const REDACT_KEYS = /(email|phone|address|contact|zip|postcode|name)/i;
const TOKEN_TTL_SECONDS = 900;
const DEFAULT_PUBLIC_REPO = "JSONbored/awesome-claude";
const DEFAULT_BASE_REF = "main";
const BRANCH_PREFIX = "heyclaude/submit";
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = "2022-11-28";

const SUPPORTED_CATEGORIES = [
  "agents",
  "mcp",
  "skills",
  "hooks",
  "commands",
  "rules",
  "guides",
  "collections",
  "statuslines",
  "tools",
];

// ---------------------------------------------------------------------------
// Config (env-driven; reviewbot's DraftConfig collapsed to module + env vars).
// ---------------------------------------------------------------------------

export function draftFlowEnabled(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.GITTENSORY_REVIEW_DRAFT ?? "").trim());
}

function draftConfig(env: Env): { publicRepo: string; baseRef: string; categories: string[]; branchPrefix: string } {
  return {
    publicRepo: env.DRAFT_PUBLIC_REPO || DEFAULT_PUBLIC_REPO,
    baseRef: env.DRAFT_BASE_REF || DEFAULT_BASE_REF,
    categories: SUPPORTED_CATEGORIES,
    branchPrefix: BRANCH_PREFIX,
  };
}

function draftSecrets(env: Env): { clientId: string; clientSecret: string; encKey: string } {
  return {
    clientId: env.GITHUB_OAUTH_CLIENT_ID ?? "",
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    encKey: env.DRAFT_TOKEN_ENCRYPTION_SECRET ?? "",
  };
}

interface DraftRow {
  id: string;
  status: string;
  category: string;
  slug: string;
  target_path: string;
  branch_name: string;
  base_ref: string;
  fields_json: string;
  auth_state_hash: string | null;
  github_login: string | null;
  fork_full_name: string | null;
  pull_request_url: string | null;
  pull_request_number: number | null;
}

// ---------------------------------------------------------------------------
// Submission form values + faithful awesome-claude MDX builder (ported verbatim
// from reviewbot src/core/draft.ts). Pure/deterministic except the submission
// timestamp `now`, which the caller supplies.
// ---------------------------------------------------------------------------

export interface SubmissionDraftFields {
  category?: unknown;
  slug?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  card_description?: unknown;
  contact_email?: unknown;
  seo_title?: unknown;
  seo_description?: unknown;
  author?: unknown;
  tags?: unknown;
  brand_name?: unknown;
  brand_domain?: unknown;
  github_url?: unknown;
  docs_url?: unknown;
  website_url?: unknown;
  download_url?: unknown;
  install_command?: unknown;
  usage_snippet?: unknown;
  config_snippet?: unknown;
  full_copyable_content?: unknown;
  guide_content?: unknown;
  command_syntax?: unknown;
  trigger?: unknown;
  script_language?: unknown;
  prerequisites?: unknown;
  safety_notes?: unknown;
  privacy_notes?: unknown;
  retrieval_sources?: unknown;
  tested_platforms?: unknown;
  skill_type?: unknown;
  skill_level?: unknown;
  verification_status?: unknown;
  verified_at?: unknown;
  items?: unknown;
  pricing_model?: unknown;
  disclosure?: unknown;
  [key: string]: unknown;
}

const MAX_SOURCE_CONTENT_CHARS = 20_000;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function mdxPlainText(value: unknown): string {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]()!])/g, "\\$1")
    .replace(/^(import|export)(\s)/gim, "\\$1$2")
    .replace(/^(#+)/gm, "\\$1");
}

export function slugify(value: unknown): string {
  return text(value)
    .slice(0, 400)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function yamlScalar(value: unknown): string {
  const normalized = text(value).replace(/\r\n?/g, "\n");
  if (normalized.includes("\n")) {
    return `|\n${normalized
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}`;
  }
  return JSON.stringify(normalized);
}

function yamlArray(values: unknown[]): string {
  const normalized = values
    .map((value) =>
      text(value)
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
  return `[${normalized.map(yamlScalar).join(", ")}]`;
}

function lines(value: unknown): string[] {
  return text(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function oneLine(value: unknown, fallback = ""): string {
  const normalized = text(value || fallback).replace(/\s+/g, " ");
  const codePoints = Array.from(normalized);
  return codePoints.length <= 160 ? normalized : `${codePoints.slice(0, 157).join("").trimEnd()}...`;
}

function validGitHubLogin(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
}

function boundedText(value: unknown, maxChars: number): string {
  return text(value).slice(0, maxChars);
}

function buildTarget(
  fields: Record<string, unknown>,
  config: { categories: string[]; branchPrefix: string },
): { category: string; slug: string; targetPath: string; branchName: string } {
  const category = String(fields.category ?? "").toLowerCase();
  if (!config.categories.includes(category)) throw new Error("Unsupported category.");
  const slug = slugify(fields.slug ?? fields.name ?? fields.title);
  if (!slug) throw new Error("Could not derive a slug from the submission.");
  return {
    category,
    slug,
    targetPath: `content/${category}/${slug}.mdx`,
    branchName: `${config.branchPrefix}-${category}-${slug}`.slice(0, 100),
  };
}

/**
 * Faithful port of reviewbot's `buildContributorMdx`. Emits the awesome-claude `validate-content`
 * frontmatter + Safety/Privacy body + MDX escaping. `now` is the submission timestamp (ISO string).
 */
export function buildContributorMdx(
  fields: SubmissionDraftFields,
  githubLogin: string | undefined,
  now: string,
  config: { categories: string[]; branchPrefix: string },
): string {
  const target = buildTarget(fields, config);
  const title = text(fields.name || fields.title);
  const description = text(fields.description || fields.card_description);
  const safeGitHubLogin = githubLogin && validGitHubLogin(githubLogin) ? githubLogin : "";
  const submittedBy = safeGitHubLogin ? `@${safeGitHubLogin}` : "website";
  const submittedByUrl = safeGitHubLogin ? `https://github.com/${safeGitHubLogin}` : "";
  const tags = text(fields.tags)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
  const sourceContent = boundedText(fields.full_copyable_content || fields.guide_content, MAX_SOURCE_CONTENT_CHARS);
  const safetyNotes = lines(fields.safety_notes);
  const privacyNotes = lines(fields.privacy_notes);
  const safeDescription = mdxPlainText(description);
  const submittedAt = new Date(now).toISOString();
  const frontmatter: string = (
    [
      "---",
      `title: ${yamlScalar(title)}`,
      `slug: ${yamlScalar(target.slug)}`,
      `category: ${yamlScalar(target.category)}`,
      `description: ${yamlScalar(description)}`,
      `cardDescription: ${yamlScalar(fields.card_description || oneLine(description))}`,
      `seoTitle: ${yamlScalar(fields.seo_title || `${title} for Claude`)}`,
      `seoDescription: ${yamlScalar(fields.seo_description || oneLine(description))}`,
      `author: ${yamlScalar(fields.author || submittedBy)}`,
      submittedByUrl ? `authorProfileUrl: ${yamlScalar(submittedByUrl)}` : null,
      `dateAdded: ${yamlScalar(submittedAt.slice(0, 10))}`,
      `submittedBy: ${yamlScalar(submittedBy)}`,
      submittedByUrl ? `submittedByUrl: ${yamlScalar(submittedByUrl)}` : null,
      `submittedAt: ${yamlScalar(submittedAt)}`,
      tags.length ? `tags: [${tags.map(yamlScalar).join(", ")}]` : "tags: []",
      text(fields.brand_name) ? `brandName: ${yamlScalar(fields.brand_name)}` : null,
      text(fields.brand_domain) ? `brandDomain: ${yamlScalar(fields.brand_domain)}` : null,
      text(fields.github_url) ? `repoUrl: ${yamlScalar(fields.github_url)}` : null,
      text(fields.docs_url) ? `documentationUrl: ${yamlScalar(fields.docs_url)}` : null,
      text(fields.website_url) ? `websiteUrl: ${yamlScalar(fields.website_url)}` : null,
      text(fields.download_url) ? `downloadUrl: ${yamlScalar(fields.download_url)}` : null,
      text(fields.install_command) ? `installCommand: ${yamlScalar(fields.install_command)}` : null,
      text(fields.usage_snippet) ? `usageSnippet: ${yamlScalar(fields.usage_snippet)}` : null,
      text(fields.config_snippet) ? `configSnippet: ${yamlScalar(fields.config_snippet)}` : null,
      sourceContent ? `copySnippet: ${yamlScalar(sourceContent)}` : null,
      text(fields.command_syntax) ? `commandSyntax: ${yamlScalar(fields.command_syntax)}` : null,
      text(fields.trigger) ? `trigger: ${yamlScalar(fields.trigger)}` : null,
      text(fields.script_language) ? `scriptLanguage: ${yamlScalar(fields.script_language)}` : null,
      text(fields.prerequisites) ? `prerequisites: ${yamlArray(lines(fields.prerequisites))}` : null,
      safetyNotes.length ? `safetyNotes: ${yamlArray(safetyNotes)}` : null,
      privacyNotes.length ? `privacyNotes: ${yamlArray(privacyNotes)}` : null,
      text(fields.retrieval_sources) ? `retrievalSources: ${yamlArray(lines(fields.retrieval_sources))}` : null,
      text(fields.tested_platforms) ? `testedPlatforms: ${yamlArray(lines(fields.tested_platforms))}` : null,
      text(fields.skill_type) ? `skillType: ${yamlScalar(fields.skill_type)}` : null,
      text(fields.skill_level) ? `skillLevel: ${yamlScalar(fields.skill_level)}` : null,
      text(fields.verification_status) ? `verificationStatus: ${yamlScalar(fields.verification_status)}` : null,
      text(fields.verified_at) ? `verifiedAt: ${yamlScalar(fields.verified_at)}` : null,
      text(fields.items) ? `items: ${yamlArray(lines(fields.items))}` : null,
      text(fields.pricing_model) ? `pricingModel: ${yamlScalar(fields.pricing_model)}` : null,
      text(fields.disclosure) ? `disclosure: ${yamlScalar(fields.disclosure)}` : null,
      "---",
    ] as Array<string | null>
  )
    .filter((line): line is string => line !== null)
    .join("\n");
  const sourceLines = lines(sourceContent).map(mdxPlainText).slice(0, 200);
  const safetyBody = mdxPlainText(fields.safety_notes) || "Maintainer review required.";
  const privacyBody = mdxPlainText(fields.privacy_notes) || "Maintainer review required.";
  const body = [
    "",
    safeDescription,
    "",
    ...(sourceLines.length ? [...sourceLines, ""] : []),
    "## Safety",
    "",
    safetyBody,
    "",
    "## Privacy",
    "",
    privacyBody,
    "",
  ].join("\n");

  return `${frontmatter}\n${body}`;
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = REDACT_KEYS.test(key) ? "[redacted]" : value;
  return out;
}

// ---------------------------------------------------------------------------
// GitHub user-token fork-PR primitives (ported from reviewbot src/core/github.ts,
// kept self-contained — they use the contributor's USER token, not an app token).
// ---------------------------------------------------------------------------

type GitHubRepo = { owner: string; repo: string };

function parseRepo(value: string): GitHubRepo {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Expected owner/repo repository name.");
  return { owner: parts[0], repo: parts[1] };
}

function encodeContentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function base64Content(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class GitHubUserApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubUserApiError";
  }
}

async function githubUserJson<T>(url: string, init: RequestInit & { token: string } = { token: "" }): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("user-agent", "gittensory-api");
  headers.set("x-github-api-version", GITHUB_API_VERSION);
  /* v8 ignore next -- token-absent arm is unreachable: every caller passes a decrypted user token; the { token: "" } default only guards the type. */
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
  const body = await response.text();
  let payload: unknown = null;
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = (payload as { message?: string } | null)?.message || body;
    throw new GitHubUserApiError(response.status, `GitHub API ${response.status}: ${message}`);
  }
  return payload as T;
}

async function githubUserJsonOrNull<T>(
  url: string,
  init: RequestInit & { token: string },
  nullStatuses: number[] = [404],
): Promise<T | null> {
  try {
    return await githubUserJson<T>(url, init);
  } catch (error) {
    if (error instanceof GitHubUserApiError && nullStatuses.includes(error.status)) return null;
    throw error;
  }
}

/** Exchange a GitHub OAuth `code` for a user access token. */
async function exchangeGitHubUserCode(params: { clientId: string; clientSecret: string; code: string; callbackUrl: string }): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.callbackUrl,
    }),
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || "GitHub auth failed.");
  return payload.access_token;
}

/** Fork the upstream repo (idempotent), commit a single file on a branch, open a PR. */
async function createUserForkContentPr(params: {
  userToken: string;
  publicRepo: string;
  baseRef: string;
  branchName: string;
  targetPath: string;
  content: string;
  title: string;
  body: string;
}): Promise<{ githubLogin: string; forkFullName: string; pullRequestUrl: string; pullRequestNumber: number }> {
  const token = params.userToken;
  const upstream = parseRepo(params.publicRepo);

  const user = await githubUserJson<{ login: string }>("https://api.github.com/user", { token });

  const createdFork = await githubUserJsonOrNull<{ full_name?: string; name?: string; owner?: { login?: string }; default_branch?: string }>(
    `https://api.github.com/repos/${upstream.owner}/${upstream.repo}/forks`,
    { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ default_branch_only: false }) },
    [404, 422],
  );
  let forkRepo = parseRepo(createdFork?.full_name || `${createdFork?.owner?.login || user.login}/${createdFork?.name || upstream.repo}`);
  let forkDefaultBranch = createdFork?.default_branch || params.baseRef;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const fork = await githubUserJsonOrNull<{ full_name?: string; default_branch?: string }>(
      `https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}`,
      { token },
    );
    if (fork) {
      if (fork.full_name) forkRepo = parseRepo(fork.full_name);
      forkDefaultBranch = fork.default_branch || forkDefaultBranch;
      break;
    }
    await sleep(3000);
  }

  const head = `${forkRepo.owner}:${params.branchName}`;
  const existingPrs = await githubUserJson<Array<{ number: number; html_url: string }>>(
    `https://api.github.com/repos/${upstream.owner}/${upstream.repo}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(params.baseRef)}`,
    { token },
  );
  const forkFullName = `${forkRepo.owner}/${forkRepo.repo}`;
  if (existingPrs[0]) {
    return { githubLogin: user.login, forkFullName, pullRequestUrl: existingPrs[0].html_url, pullRequestNumber: existingPrs[0].number };
  }

  const baseRefData = await githubUserJsonOrNull<{ object?: { sha?: string } }>(
    `https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}/git/ref/heads/${encodeURIComponent(params.baseRef)}`,
    { token },
  );
  const fallbackRefData = baseRefData
    ? null
    : await githubUserJsonOrNull<{ object?: { sha?: string } }>(
        `https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}/git/ref/heads/${encodeURIComponent(forkDefaultBranch)}`,
        { token },
      );
  const baseSha = baseRefData?.object?.sha || fallbackRefData?.object?.sha;
  if (!baseSha) throw new Error("Could not resolve fork base SHA.");

  const branchRef = `heads/${params.branchName}`;
  const existingBranch = await githubUserJsonOrNull(`https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}/git/ref/${branchRef}`, { token });
  if (existingBranch) {
    await githubUserJson(`https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}/git/refs/${branchRef}`, {
      method: "PATCH",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: baseSha, force: true }),
    });
  } else {
    await githubUserJson(`https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}/git/refs`, {
      method: "POST",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${params.branchName}`, sha: baseSha }),
    });
  }

  const existingFile = await githubUserJsonOrNull<{ sha?: string }>(
    `https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}/contents/${encodeContentPath(params.targetPath)}?ref=${encodeURIComponent(params.branchName)}`,
    { token },
  );
  await githubUserJson(`https://api.github.com/repos/${forkRepo.owner}/${forkRepo.repo}/contents/${encodeContentPath(params.targetPath)}`, {
    method: "PUT",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: params.title,
      content: base64Content(params.content),
      branch: params.branchName,
      ...(existingFile?.sha ? { sha: existingFile.sha } : {}),
    }),
  });

  const pr = await githubUserJson<{ number: number; html_url: string }>(`https://api.github.com/repos/${upstream.owner}/${upstream.repo}/pulls`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: params.title, body: params.body, head, base: params.baseRef, maintainer_can_modify: true }),
  });
  return { githubLogin: user.login, forkFullName, pullRequestUrl: pr.html_url, pullRequestNumber: pr.number };
}

// ---------------------------------------------------------------------------
// HTTP handlers (Hono-agnostic — return a plain Response).
// ---------------------------------------------------------------------------

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown-ip";
}

function json(data: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

const DRAFT_OAUTH_COOKIE = "gittensory_draft_oauth";

function parseCookieHeader(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      cookies[name] = "";
    }
  }
  return cookies;
}

function draftOAuthCookie(state: string, origin: string, maxAgeSeconds: number): string {
  const secure = new URL(origin).protocol === "https:" ? "; Secure" : "";
  return `${DRAFT_OAUTH_COOKIE}=${encodeURIComponent(state)}; Path=/v1/drafts/auth/callback; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

export async function handleDraftCreate(request: Request, env: Env): Promise<Response> {
  if (!draftFlowEnabled(env)) return new Response("not found", { status: 404 });
  if (!(request.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "expected_json" }, 415);

  const config = draftConfig(env);
  const { clientId, encKey } = draftSecrets(env);
  if (!clientId || !encKey) return json({ ok: false, error: "draft_flow_not_configured" }, 503);

  const raw = await request.text();
  if (raw.length > 64 * 1024) return json({ ok: false, error: "too_large" }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    body = typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const fields = (typeof body.fields === "object" && body.fields ? body.fields : body) as Record<string, unknown>;

  let target: { category: string; slug: string; targetPath: string; branchName: string };
  try {
    target = buildTarget(fields, config);
  } catch (error) {
    /* v8 ignore next -- buildTarget only throws Error, so the non-Error "invalid_submission" arm is unreachable. */
    return json({ ok: false, error: error instanceof Error ? error.message : "invalid_submission" }, 400);
  }

  const id = newDraftId("draft");
  const state = randomDraftToken();
  await env.DB.prepare(
    `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json, auth_state_hash)
     VALUES (?, 'auth_required', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, target.category, target.slug, target.targetPath, target.branchName, config.baseRef, JSON.stringify(fields), await sha256Hex(state))
    .run();

  // Audit a draft start without leaking the submitter — the IP is hashed-equivalent only via the rate limiter upstream.
  void clientIp(request);

  const origin = new URL(request.url).origin;
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", `${origin}/v1/drafts/auth/callback`);
  authUrl.searchParams.set("state", `${id}.${state}`);

  return json({ ok: true, draftId: id, statusUrl: `/v1/drafts/${id}`, authUrl: authUrl.toString(), target }, 201, { "set-cookie": draftOAuthCookie(`${id}.${state}`, origin, 10 * 60) });
}

export async function handleDraftStatus(_request: Request, env: Env, draftId: string): Promise<Response> {
  if (!draftFlowEnabled(env)) return new Response("not found", { status: 404 });
  const row = await env.DB.prepare(`SELECT * FROM submission_drafts WHERE id = ?`).bind(draftId).first<DraftRow>();
  if (!row) return json({ ok: false, error: "not_found" }, 404);
  let fields: Record<string, unknown> = {};
  try {
    fields = JSON.parse(row.fields_json) as Record<string, unknown>;
  } catch {
    fields = {};
  }
  return json(
    {
      ok: true,
      draft: {
        id: row.id,
        status: row.status,
        category: row.category,
        slug: row.slug,
        targetPath: row.target_path,
        fields: redactFields(fields),
        githubLogin: row.github_login,
        pullRequestUrl: row.pull_request_url,
        pullRequestNumber: row.pull_request_number,
      },
    },
    200,
  );
}

export async function handleDraftOAuthCallback(request: Request, env: Env): Promise<Response> {
  if (!draftFlowEnabled(env)) return new Response("not found", { status: 404 });
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const providerError = url.searchParams.get("error") || "";
  const state = url.searchParams.get("state") || "";
  const [draftId, stateToken] = state.split(".");
  if (!draftId || !stateToken) return new Response("Invalid submission state.", { status: 400 });

  const cookieState = parseCookieHeader(request.headers.get("cookie"))[DRAFT_OAUTH_COOKIE] || "";
  if (!cookieState || !timingSafeEqualHex(await sha256Hex(cookieState), await sha256Hex(state))) {
    return new Response("Invalid or expired submission state.", { status: 400 });
  }

  const row = await env.DB.prepare(`SELECT * FROM submission_drafts WHERE id = ?`).bind(draftId).first<DraftRow>();
  // Constant-time compare of the OAuth-state hash (CSRF token); both are lowercase hex SHA-256.
  if (!row?.auth_state_hash || !timingSafeEqualHex(await sha256Hex(stateToken), row.auth_state_hash)) {
    return new Response("Invalid or expired submission state.", { status: 400 });
  }
  if (providerError || !code) return new Response("GitHub authorization was not completed.", { status: 400 });

  const { clientId, clientSecret, encKey } = draftSecrets(env);
  if (!clientId || !clientSecret || !encKey) return new Response("Draft flow not configured.", { status: 503 });

  let userToken: string;
  try {
    userToken = await exchangeGitHubUserCode({ clientId, clientSecret, code, callbackUrl: `${url.origin}/v1/drafts/auth/callback` });
  } catch {
    return new Response("GitHub authorization failed.", { status: 400 });
  }

  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO submission_user_tokens (draft_id, encrypted_token, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(draft_id) DO UPDATE SET encrypted_token = excluded.encrypted_token, expires_at = excluded.expires_at, consumed_at = NULL`,
  )
    .bind(draftId, await encryptDraftToken(encKey, userToken), expiresAt)
    .run();
  await env.DB.prepare(`UPDATE submission_drafts SET status = 'queued', auth_state_hash = NULL, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), draftId)
    .run();

  await env.JOBS.send({ type: "submit-draft", requestedBy: "api", draftId });

  return new Response(`<meta http-equiv="refresh" content="0; url=/v1/drafts/${draftId}">Submission queued.`, {
    headers: { "content-type": "text/html", "set-cookie": draftOAuthCookie("", url.origin, 0) },
  });
}

/** Queue handler for submit-draft: fork + open the content PR with the user's token. */
export async function processSubmitDraft(env: Env, draftId: string): Promise<void> {
  if (!draftFlowEnabled(env)) return;
  const config = draftConfig(env);
  const row = await env.DB.prepare(`SELECT * FROM submission_drafts WHERE id = ?`).bind(draftId).first<DraftRow>();
  if (!row || row.status === "pr_open") return;

  const tokenRow = await env.DB.prepare(`SELECT encrypted_token, expires_at, consumed_at FROM submission_user_tokens WHERE draft_id = ?`)
    .bind(draftId)
    .first<{ encrypted_token: string; expires_at: string; consumed_at: string | null }>();
  const { encKey } = draftSecrets(env);
  // Fail closed on an unparseable expiry: new Date(...).getTime() -> NaN makes `NaN < Date.now()` false,
  // which would otherwise treat a token whose stored expires_at is malformed/empty as never expired.
  // Mirrors src/auth/security.ts' Number.isFinite(expiresAtMs) session-expiry guard.
  const expiresAtMs = tokenRow ? Date.parse(tokenRow.expires_at) : NaN;
  if (!tokenRow || tokenRow.consumed_at || !Number.isFinite(expiresAtMs) || expiresAtMs < Date.now() || !encKey) {
    await env.DB.prepare(`UPDATE submission_drafts SET status = 'error', last_error = 'token_unavailable', updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), draftId)
      .run();
    return;
  }

  let fields: Record<string, unknown> = {};
  try {
    fields = JSON.parse(row.fields_json) as Record<string, unknown>;
  } catch {
    fields = {};
  }

  try {
    const userToken = await decryptDraftToken(encKey, tokenRow.encrypted_token);
    const now = new Date().toISOString();
    const content = buildContributorMdx(fields, row.github_login ?? undefined, now, config);
    const title = `Add ${row.category}: ${String(fields.name ?? fields.title ?? row.slug)}`;
    const pr = await createUserForkContentPr({
      userToken,
      publicRepo: config.publicRepo,
      baseRef: row.base_ref,
      branchName: row.branch_name,
      targetPath: row.target_path,
      content,
      title,
      body: "PR-first submission created via gittensory. The submission gate will review category fit, sources, duplicates, safety, and scope.",
    });
    await env.DB.prepare(
      `UPDATE submission_drafts SET status = 'pr_open', github_login = ?, fork_full_name = ?, pull_request_url = ?, pull_request_number = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(pr.githubLogin, pr.forkFullName, pr.pullRequestUrl, pr.pullRequestNumber, new Date().toISOString(), draftId)
      .run();
    await env.DB.prepare(`UPDATE submission_user_tokens SET consumed_at = ? WHERE draft_id = ?`).bind(new Date().toISOString(), draftId).run();
  } catch (error) {
    // every throw in the try block is an Error/GitHubUserApiError, so the non-Error "submit_failed" arm is unreachable.
    /* v8 ignore start */
    const lastError = error instanceof Error ? error.message : "submit_failed";
    /* v8 ignore stop */
    await env.DB.prepare(`UPDATE submission_drafts SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(lastError, new Date().toISOString(), draftId)
      .run();
  }
}
