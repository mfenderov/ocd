import { ACCESS_ASSERTION_HEADER, unauthorized } from "./access";
import { extractBearer } from "./heartbeat";
import { exact, findRoute, requiredId, singleId, type Route } from "./routes";
import { FleetState } from "./state";

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

// What a route's handler gets: the request, the env, the URL, and the id
// the path names.
interface EdgeContext {
  request: Request;
  env?: Env;
  url: URL;
  // The id the path names, empty when the path names none.
  id: string;
}

type EdgeRoute = Route<(ctx: EdgeContext) => Promise<Response>>;

// The edge's routes: a table, not a switch.
//
// Each row says which method and path it answers, the scope it needs (a
// row without a scope carries its own auth: the boxes bring their own
// tokens, the enrolment approves through capability links), and the
// handler that answers. The order is the order the brain answers in.
export const EDGE_ROUTES: readonly EdgeRoute[] = [
  // The brain's front door. The secret header rides along to the DO, which
  // is the one that checks it.
  { method: "POST", path: exact("/tg/webhook"), handler: (c) => forwardToDo(c.request, c.env, "/tg") },
  // The reads: the boxes the brain knows, and the fleet's history.
  { method: "GET", path: exact("/api/backends"), scope: "audit", handler: (c) => forwardToDo(c.request, c.env, "/backends") },
  { method: "GET", path: exact("/api/audit"), scope: "audit", handler: handleAuditApi },
  // The revokes.
  { method: "POST", path: exact("/api/revoke-all"), scope: "revoke", handler: (c) => forwardToDo(c.request, c.env, "/revoke-all") },
  {
    method: "POST",
    path: requiredId("/api/backends/", "/revoke"),
    scope: "revoke",
    handler: (c) => forwardToDo(c.request, c.env, `/revoke/${encodeURIComponent(c.id)}`),
  },
  // The mint: the box mints its own tap code.
  {
    method: "POST",
    path: requiredId("/api/backends/", "/link"),
    scope: "link",
    handler: handleLinkApi,
  },
  // The per-box relays: the box's presence and its status. Both are reads
  // and need the audit scope, like the other read routes.
  {
    method: "GET",
    path: requiredId("/api/backends/", "/presence"),
    scope: "audit",
    handler: (c) => forwardToDo(c.request, c.env, `/presence/${encodeURIComponent(c.id)}`),
  },
  {
    method: "GET",
    path: requiredId("/api/backends/", "/status"),
    scope: "audit",
    handler: (c) => forwardToDo(c.request, c.env, `/status/${encodeURIComponent(c.id)}`),
  },
  // The boxes' own door: the box authenticates itself with its heartbeat
  // token and names itself in the body. The route carries no scope — a
  // console token must not be able to forge box events.
  { method: "POST", path: exact("/api/heartbeat"), handler: (c) => forwardToDo(c.request, c.env, "/heartbeat") },
  { method: "POST", path: exact("/api/events"), handler: (c) => forwardToDo(c.request, c.env, "/events") },
  // The enrolment: the request, the approve tap and the deny tap.
  { method: "POST", path: exact("/api/enroll"), handler: (c) => handleEnrollApi(c, "/enroll") },
  { method: "GET", path: exact("/api/enroll/approve"), handler: (c) => handleEnrollApi(c, "/enroll/approve") },
  { method: "GET", path: exact("/api/enroll/deny"), handler: (c) => handleEnrollApi(c, "/enroll/deny") },
  // The token lifecycle: mint, rotate, revoke. These carry their own auth.
  { method: "POST", path: exact("/api/tokens"), handler: (c) => forwardToDo(c.request, c.env, "/tokens") },
  {
    method: "POST",
    path: requiredId("/api/tokens/", "/rotate"),
    handler: (c) => forwardToDo(c.request, c.env, `/tokens/${encodeURIComponent(c.id)}/rotate`),
  },
  {
    method: "DELETE",
    path: singleId("/api/tokens/"),
    handler: (c) => forwardToDo(c.request, c.env, `/tokens/${encodeURIComponent(c.id)}`),
  },
];

// The enrolment routes: the query string rides along — capability links
// carry id/exp/sig as params.
async function handleEnrollApi(ctx: EdgeContext, doPath: string): Promise<Response> {
  if (!ctx.env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = ctx.env.FLEET_STATE.get(ctx.env.FLEET_STATE.idFromName("fleet"));
  const search = ctx.url.search;
  return await stub.fetch(new Request(`http://do${doPath}${search}`, ctx.request));
}

// The link route: the box id comes out of the path.
async function handleLinkApi(ctx: EdgeContext): Promise<Response> {
  if (!ctx.env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = ctx.env.FLEET_STATE.get(ctx.env.FLEET_STATE.idFromName("fleet"));
  return await stub.fetch(
    new Request(`http://do/link/${encodeURIComponent(ctx.id)}`, ctx.request),
  );
}

// The audit route: the box/n filter params belong to the DO handler.
async function handleAuditApi(ctx: EdgeContext): Promise<Response> {
  if (!ctx.env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = ctx.env.FLEET_STATE.get(ctx.env.FLEET_STATE.idFromName("fleet"));
  const search = ctx.url.search;
  return await stub.fetch(new Request(`http://do/audit${search}`, ctx.request));
}

// The fast path: a guarded route with no credential at all (no bearer, no
// Access assertion) cannot authorize — 401 without a DO roundtrip.
// Scope/JWT validity is enforced DO-side in state.ts. With no binding the
// route handlers still fail loud 500 below, so this yields to them when
// env is missing.
function credentialless(route: EdgeRoute, request: Request, env?: Env): boolean {
  if (!route.scope || !env?.FLEET_STATE) {
    return false;
  }
  return !extractBearer(request) && !request.headers.get(ACCESS_ASSERTION_HEADER);
}

export default {
  async fetch(request: Request, env?: Env): Promise<Response> {
    const url = new URL(request.url);
    const found = findRoute(EDGE_ROUTES, request.method, url.pathname);
    if (!found) {
      return new Response("Not Found", { status: 404 });
    }
    if (credentialless(found.route, request, env)) {
      return unauthorized();
    }
    return found.route.handler({ request, env, url, id: found.id });
  },
};
