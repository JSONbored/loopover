import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #9045 structural guard. `GET /v1/repos/:owner/:repo/pulls/:number/maintainer-packet` shipped gated only by
 * `requireStaticProtectedApiToken`, which admits ANY static identity including the shared, end-user-obtainable
 * `mcp` token — it never checked `isMcpReadRepoAllowed`. Its three sibling repo-scoped routes each hand-rolled
 * that check; this one simply omitted it, so the HTTP surface granted what the MCP surface denied for the same
 * token, and `MCP_READ_REPO_ALLOWLIST` is fail-closed by default (unset ⇒ deny all) — the intended posture was
 * "deny everything" while this route allowed everything.
 *
 * The fix folded the allowlist INTO the gate (an optional `repoFullName` argument), so the correct behavior is
 * now the one you get by passing the repo you already have. This test closes the remaining gap: it fails if a
 * repo-scoped route calls the gate WITHOUT that argument, so the omission cannot be reintroduced silently by a
 * future route. A source-text assertion is the right tool here precisely because the defect was an *absent*
 * call — there is no runtime behavior to observe on the route that forgot it.
 */
describe("repo-scoped routes must pass repoFullName to requireStaticProtectedApiToken (#9045)", () => {
  const source = readFileSync(join(process.cwd(), "src/api/routes.ts"), "utf8");

  it("every requireStaticProtectedApiToken call inside a /v1/repos/:owner/:repo route is repo-scoped", () => {
    // Walk each `app.<verb>("<path>", ...)` registration and pair it with the gate calls in its handler body,
    // bounded by the next registration so a call can never be attributed to the wrong route.
    const registrations = [...source.matchAll(/app\.(get|post|put|patch|delete)\("([^"]+)"/g)];
    const offenders: string[] = [];

    for (const [index, match] of registrations.entries()) {
      const routePath = match[2]!;
      const bodyStart = match.index!;
      const bodyEnd = registrations[index + 1]?.index ?? source.length;
      const body = source.slice(bodyStart, bodyEnd);
      if (!body.includes("requireStaticProtectedApiToken(")) continue;
      // Only routes that actually carry a repo in the path can be repo-scoped.
      if (!routePath.includes("/v1/repos/:owner/:repo")) continue;
      // The gate must receive a second argument (the repo), not just the context.
      const bareCalls = [...body.matchAll(/requireStaticProtectedApiToken\(\s*c\s*\)/g)];
      if (bareCalls.length > 0) offenders.push(routePath);
    }

    expect(offenders).toEqual([]);
  });

  it("the gate itself still enforces the allowlist when a repo is supplied", () => {
    // Guards against the inverse regression: someone keeps the call sites but guts the check inside the gate.
    const gate = source.slice(source.indexOf("async function requireStaticProtectedApiToken("));
    const gateBody = gate.slice(0, gate.indexOf("\n}\n") + 3);
    expect(gateBody).toContain("isMcpReadRepoAllowed");
    expect(gateBody).toContain("MCP_READ_REPO_ALLOWLIST");
    expect(gateBody).toContain("forbidden_repo");
  });

  it("finds the repo-scoped routes it is meant to be guarding (the walker is not silently matching nothing)", () => {
    const registrations = [...source.matchAll(/app\.(get|post|put|patch|delete)\("([^"]+)"/g)];
    const repoScopedGated = registrations.filter((match, index) => {
      const body = source.slice(match.index!, registrations[index + 1]?.index ?? source.length);
      return match[2]!.includes("/v1/repos/:owner/:repo") && body.includes("requireStaticProtectedApiToken(");
    });
    // maintainer-packet, reviewability, gate-config/effective, live-gate-thresholds.
    expect(repoScopedGated.length).toBeGreaterThanOrEqual(4);
  });
});
