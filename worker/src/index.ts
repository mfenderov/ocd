import { ACCESS_ASSERTION_HEADER, scopeForEdgeRoute, unauthorized } from "./access";
import { extractBearer } from "./heartbeat";
import { FleetState } from "./state";
import type { CliScope } from "./tokens";

export { FleetState };

export interface Env {
  FLEET_STATE: DurableObjectNamespace;
  // Cloudflare Access browser bypass (API dual-auth): same vars the DO reads.
  // Unset = deny-all fail-closed for JWT-bearer API calls, mirroring the CLI-token guards.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAIL?: string;
}

// Single choke point for every plain DO passthrough: binding check, then
// forward method + mapped path + headers + body verbatim. Backends reads go
// through here too so the Authorization/Access headers reach the DO scope
// guard. Routes needing more (query preservation in enroll/audit, id
// extraction in link) keep their own helpers.
export async function forwardToDo(
  request: Request,
  env: Env | undefined,
  doPath: string,
): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return await stub.fetch(new Request(`http://do${doPath}`, request));
}

async function handleEnrollApi(request: Request, env: Env | undefined, doPath: string): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  // Preserve the query string: capability links carry id/exp/sig as params.
  const search = new URL(request.url).search;
  return await stub.fetch(new Request(`http://do${doPath}${search}`, request));
}

async function handleLinkApi(request: Request, env: Env | undefined): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  const pathname = new URL(request.url).pathname;
  const id = pathname.slice(0, -"/link".length).slice("/api/backends/".length);
  return await stub.fetch(
    new Request(`http://do/link/${encodeURIComponent(id)}`, request),
  );
}

async function handleAuditApi(request: Request, env?: Env): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  // Preserve the query string: box/n filter params belong to the DO handler.
  const search = new URL(request.url).search;
  return await stub.fetch(new Request(`http://do/audit${search}`, request));
}

export default {
  async fetch(request: Request, env?: Env): Promise<Response> {
    const url = new URL(request.url);
    // Task 2 edge fast-path: a guarded route with no credential at all (no
    // bearer, no Access assertion) cannot authorize — 401 without a DO
    // roundtrip. Scope/JWT validity is enforced DO-side in state.ts. With no
    // binding the route handlers still fail loud 500 below, so this yields
    // to them when env is missing.
    const scope: CliScope | null = scopeForEdgeRoute(request.method, url.pathname);
    if (
      scope &&
      env?.FLEET_STATE &&
      !extractBearer(request) &&
      !request.headers.get(ACCESS_ASSERTION_HEADER)
    ) {
      return unauthorized();
    }
    if (request.method === "POST" && url.pathname === "/tg/webhook") {
      // Telegram's webhook: the brain's front door. The secret header
      // rides along to the DO, which is the one that checks it.
      return forwardToDo(request, env, "/tg");
    }
    if (request.method === "GET" && url.pathname === "/api/backends") {
      return forwardToDo(request, env, "/backends");
    }
    if (request.method === "GET" && url.pathname === "/api/audit") {
      return handleAuditApi(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/revoke-all") {
      return forwardToDo(request, env, "/revoke-all");
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/backends/") &&
      url.pathname.endsWith("/revoke") &&
      url.pathname.length > "/api/backends//revoke".length
    ) {
      const id = url.pathname.slice(0, -"/revoke".length).slice("/api/backends/".length);
      return forwardToDo(request, env, `/revoke/${encodeURIComponent(id)}`);
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/backends/") &&
      url.pathname.endsWith("/link") &&
      url.pathname.length > "/api/backends//link".length
    ) {
      return handleLinkApi(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/heartbeat") {
      return forwardToDo(request, env, "/heartbeat");
    }
    if (request.method === "POST" && url.pathname === "/api/events") {
      // The boxes' door: the box authenticates itself with its heartbeat
      // token and names itself in the body. The route is not in the scope
      // map — a console token must not be able to forge box events.
      return forwardToDo(request, env, "/events");
    }
    if (request.method === "POST" && url.pathname === "/api/enroll") {
      return handleEnrollApi(request, env, "/enroll");
    }
    if (request.method === "GET" && url.pathname === "/api/enroll/approve") {
      return handleEnrollApi(request, env, "/enroll/approve");
    }
    if (request.method === "GET" && url.pathname === "/api/enroll/deny") {
      return handleEnrollApi(request, env, "/enroll/deny");
    }
    if (request.method === "POST" && url.pathname === "/api/tokens") {
      return forwardToDo(request, env, "/tokens");
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/tokens/") &&
      url.pathname.endsWith("/rotate") &&
      url.pathname.length > "/api/tokens//rotate".length
    ) {
      const id = url.pathname.slice("/api/tokens/".length, -"/rotate".length);
      return forwardToDo(request, env, `/tokens/${encodeURIComponent(id)}/rotate`);
    }
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith("/api/tokens/") &&
      !url.pathname.slice("/api/tokens/".length).includes("/") &&
      url.pathname.length > "/api/tokens/".length
    ) {
      const id = url.pathname.slice("/api/tokens/".length);
      return forwardToDo(request, env, `/tokens/${encodeURIComponent(id)}`);
    }
    return new Response("Not Found", { status: 404 });
  },
};
