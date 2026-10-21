import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleMintToken } from "../src/tokens";
import { inState } from "./helpers";

// The brain's routes, as a table.
//
// This is the characterisation of the two routers: the edge (worker/src/
// index.ts) and the Durable Object (worker/src/state.ts). Every row says
// which method and path answers, and what it answers. The routers may
// change their shape — a switch becomes a table — but the answer a
// method and a path get must never change.
//
// The rows that matter most are the ones a naive table would get wrong:
// the degenerate ids ("/api/backends//revoke" is no route), the empty
// ids on the DO ("/revoke/" is a route that answers "bad_request"), and
// the guarded routes, where the scope check runs before the handler.

const BOOTSTRAP = "test-bootstrap-routes";

// A token with every scope, minted straight into the DO: the edge routes
// forward the bearer to the DO, so one token serves both routers.
let allToken = "";

beforeAll(async () => {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  allToken = await inState(stub, async (instance) => {
    const res = await handleMintToken(
      new Request("https://fleet.local/tokens", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BOOTSTRAP}` },
        body: JSON.stringify({}),
      }),
      instance,
      { bootstrapSecret: BOOTSTRAP },
    );
    expect(res.status).toBe(200);
    return (await res.json<{ token: string }>()).token;
  });
});

interface Call {
  method: string;
  path: string;
  /** The bearer to present: none, or the all-scope token. */
  bearer?: string;
  body?: unknown;
}

async function edge(call: Call): Promise<Response> {
  const headers: Record<string, string> = {};
  if (call.bearer !== undefined) {
    headers["authorization"] = `Bearer ${call.bearer}`;
  }
  if (call.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return SELF.fetch(`https://fleet.local${call.path}`, {
    method: call.method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
}

async function durable(call: Call): Promise<Response> {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  const headers: Record<string, string> = {};
  if (call.bearer !== undefined) {
    headers["authorization"] = `Bearer ${call.bearer}`;
  }
  if (call.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return inState(stub, async (instance) =>
    instance.fetch(
      new Request(`http://do${call.path}`, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
      }),
    ),
  );
}

// The edge routes, in the order the router answers them.
const EDGE_CASES: Array<{ call: Call; status: number; error?: string; body?: Record<string, unknown> }> = [
  // The guarded routes: no credential at all is a 401 before the handler.
  { call: { method: "GET", path: "/api/backends" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/api/audit" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/api/revoke-all" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/api/backends/ghost/revoke" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/api/backends/ghost/link" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/api/backends/ghost/presence" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/api/backends/ghost/status" }, status: 401, error: "unauthorized" },
  // The unguarded routes keep their own auth.
  {
    call: { method: "POST", path: "/api/heartbeat", body: { id: "ghost", seq: 1, box_now: 1, epoch: 0 } },
    status: 401,
    error: "unauthorized",
  },
  { call: { method: "POST", path: "/api/heartbeat" }, status: 400, error: "bad_request" },
  { call: { method: "POST", path: "/api/events" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/api/enroll", body: { id: "ghost" } }, status: 400, error: "bad_request" },
  { call: { method: "GET", path: "/api/enroll/approve" }, status: 400, error: "bad_request" },
  { call: { method: "GET", path: "/api/enroll/deny" }, status: 400, error: "bad_request" },
  { call: { method: "POST", path: "/api/tokens", body: {} }, status: 403, error: "forbidden" },
  { call: { method: "POST", path: "/api/tokens" }, status: 400, error: "bad_request" },
  { call: { method: "POST", path: "/api/tokens/t-1/rotate" }, status: 403, error: "forbidden" },
  { call: { method: "DELETE", path: "/api/tokens/t-1" }, status: 403, error: "forbidden" },
  { call: { method: "POST", path: "/tg/webhook" }, status: 401, error: "unauthorized" },
  // No route at all.
  { call: { method: "GET", path: "/api/nope" }, status: 404 },
  { call: { method: "PUT", path: "/api/backends" }, status: 404 },
  // A degenerate id is no route: the scope check does not fire either.
  { call: { method: "POST", path: "/api/backends//revoke" }, status: 404 },
  { call: { method: "POST", path: "/api/backends//link" }, status: 404 },
  // The id may hold a "/", so a path with three slashes names the id
  // "/" — and that is a route: the scope check fires and the handler
  // answers. The empty id is the only one that is not a route.
  { call: { method: "POST", path: "/api/backends///revoke" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/api/backends///link" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/api/backends///presence" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/api/backends///status" }, status: 401, error: "unauthorized" },
  // The guarded routes with a credential: the handler answers.
  { call: { method: "GET", path: "/api/backends", bearer: "TOKEN" }, status: 200 },
  { call: { method: "GET", path: "/api/audit?box=ghost", bearer: "TOKEN" }, status: 404 },
  { call: { method: "POST", path: "/api/revoke-all", bearer: "TOKEN" }, status: 400, error: "confirm_required" },
  { call: { method: "POST", path: "/api/backends/ghost/revoke", bearer: "TOKEN" }, status: 400, error: "confirm_required" },
  {
    call: { method: "POST", path: "/api/backends/ghost/revoke", bearer: "TOKEN", body: { confirm: true } },
    status: 404,
    body: { id: "ghost", status: "unknown_box" },
  },
  { call: { method: "POST", path: "/api/backends/ghost/link", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "GET", path: "/api/backends/ghost/presence", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "GET", path: "/api/backends/ghost/status", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  // The empty id is no route, with a credential either.
  { call: { method: "POST", path: "/api/backends//revoke", bearer: "TOKEN" }, status: 404 },
  // The id "/" is a route like any other: the handler answers it.
  { call: { method: "POST", path: "/api/backends///revoke", bearer: "TOKEN" }, status: 400, error: "confirm_required" },
  { call: { method: "POST", path: "/api/backends///link", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "GET", path: "/api/backends///presence", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "GET", path: "/api/backends///status", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "POST", path: "/api/tokens/t-1/rotate", bearer: "TOKEN" }, status: 404, error: "unknown_token" },
  { call: { method: "DELETE", path: "/api/tokens/t-1", bearer: "TOKEN" }, status: 404, error: "unknown_token" },
];

// The DO's routes, in the order the DO answers them.
const DO_CASES: Array<{ call: Call; status: number; error?: string; body?: Record<string, unknown> }> = [
  { call: { method: "GET", path: "/backends" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/audit" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/revoke-all" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/revoke/ghost" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/link/ghost" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/presence/ghost" }, status: 401, error: "unauthorized" },
  { call: { method: "GET", path: "/status/ghost" }, status: 401, error: "unauthorized" },
  // The unguarded routes keep their own auth.
  {
    call: { method: "POST", path: "/heartbeat", body: { id: "ghost", seq: 1, box_now: 1, epoch: 0 } },
    status: 401,
    error: "unauthorized",
  },
  { call: { method: "POST", path: "/heartbeat" }, status: 400, error: "bad_request" },
  { call: { method: "POST", path: "/events" }, status: 401, error: "unauthorized" },
  { call: { method: "POST", path: "/enroll", body: { id: "ghost" } }, status: 400, error: "bad_request" },
  { call: { method: "GET", path: "/enroll/approve" }, status: 400, error: "bad_request" },
  { call: { method: "GET", path: "/enroll/deny" }, status: 400, error: "bad_request" },
  { call: { method: "POST", path: "/tg" }, status: 401, error: "unauthorized" },
  // No route at all.
  { call: { method: "GET", path: "/nope" }, status: 404 },
  { call: { method: "PUT", path: "/backends" }, status: 404 },
  // The empty id is a route that answers "bad_request" — not a 404.
  { call: { method: "POST", path: "/revoke/", bearer: "TOKEN" }, status: 400, error: "bad_request" },
  { call: { method: "POST", path: "/link/", bearer: "TOKEN" }, status: 400, error: "bad_request" },
  { call: { method: "GET", path: "/presence/", bearer: "TOKEN" }, status: 400, error: "bad_request" },
  { call: { method: "GET", path: "/status/", bearer: "TOKEN" }, status: 400, error: "bad_request" },
  { call: { method: "POST", path: "/tokens/rotate", bearer: "TOKEN" }, status: 400, error: "bad_request" },
  // The empty token id is a route that answers "bad_request" — the DO's
  // delete rule takes the rest of the path, empty or not.
  { call: { method: "DELETE", path: "/tokens/", bearer: "TOKEN" }, status: 400, error: "bad_request" },
  // The guarded routes with a credential: the handler answers.
  { call: { method: "GET", path: "/backends", bearer: "TOKEN" }, status: 200 },
  { call: { method: "GET", path: "/audit?box=ghost", bearer: "TOKEN" }, status: 404 },
  { call: { method: "POST", path: "/revoke-all", bearer: "TOKEN" }, status: 400, error: "confirm_required" },
  {
    call: { method: "POST", path: "/revoke/ghost", bearer: "TOKEN", body: { confirm: true } },
    status: 404,
    body: { id: "ghost", status: "unknown_box" },
  },
  { call: { method: "POST", path: "/link/ghost", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "GET", path: "/presence/ghost", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "GET", path: "/status/ghost", bearer: "TOKEN" }, status: 404, error: "unknown_box" },
  { call: { method: "POST", path: "/tokens/t-1/rotate", bearer: "TOKEN" }, status: 404, error: "unknown_token" },
  { call: { method: "DELETE", path: "/tokens/t-1", bearer: "TOKEN" }, status: 404, error: "unknown_token" },
];

describe("the edge routes", () => {
  it("every route answers the same way it always did", async () => {
    for (const c of EDGE_CASES) {
      const res = await edge({ ...c.call, bearer: c.call.bearer === "TOKEN" ? allToken : c.call.bearer });
      const label = `${c.call.method} ${c.call.path}`;
      expect(`${label} -> ${res.status}`, label).toBe(`${label} -> ${c.status}`);
      if (c.error !== undefined) {
        expect(await res.json(), label).toMatchObject({ error: c.error });
      } else if (c.body !== undefined) {
        expect(await res.json(), label).toMatchObject(c.body);
      }
    }
  });
});

describe("the DO routes", () => {
  it("every route answers the same way it always did", async () => {
    for (const c of DO_CASES) {
      const res = await durable({ ...c.call, bearer: c.call.bearer === "TOKEN" ? allToken : c.call.bearer });
      const label = `${c.call.method} ${c.call.path}`;
      expect(`${label} -> ${res.status}`, label).toBe(`${label} -> ${c.status}`);
      if (c.error !== undefined) {
        expect(await res.json(), label).toMatchObject({ error: c.error });
      } else if (c.body !== undefined) {
        expect(await res.json(), label).toMatchObject(c.body);
      }
    }
  });
});
