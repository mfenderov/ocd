import { FleetState } from "./state";

export { FleetState };

export interface Env {
  FLEET_STATE: DurableObjectNamespace;
}

async function handleBackends(env?: Env): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return await stub.fetch("http://do/backends");
}

async function handleHeartbeatApi(request: Request, env?: Env): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return await stub.fetch(new Request("http://do/heartbeat", request));
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

async function handleRevokeApi(request: Request, env: Env | undefined, doPath: string): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return await stub.fetch(new Request(`http://do${doPath}`, request));
}

async function handleTokensApi(request: Request, env: Env | undefined, doPath: string): Promise<Response> {
  if (!env?.FLEET_STATE) {
    console.error("FLEET_STATE binding is not configured");
    return new Response("FLEET_STATE binding is not configured", {
      status: 500,
    });
  }
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return await stub.fetch(new Request(`http://do${doPath}`, request));
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
    if (request.method === "GET" && url.pathname === "/api/backends") {
      return handleBackends(env);
    }
    if (request.method === "GET" && url.pathname === "/api/audit") {
      return handleAuditApi(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/revoke-all") {
      return handleRevokeApi(request, env, "/revoke-all");
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/backends/") &&
      url.pathname.endsWith("/revoke") &&
      url.pathname.length > "/api/backends//revoke".length
    ) {
      const id = url.pathname.slice(0, -"/revoke".length).slice("/api/backends/".length);
      return handleRevokeApi(request, env, `/revoke/${encodeURIComponent(id)}`);
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
      return handleHeartbeatApi(request, env);
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
      return handleTokensApi(request, env, "/tokens");
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/tokens/") &&
      url.pathname.endsWith("/rotate") &&
      url.pathname.length > "/api/tokens//rotate".length
    ) {
      const id = url.pathname.slice("/api/tokens/".length, -"/rotate".length);
      return handleTokensApi(request, env, `/tokens/${encodeURIComponent(id)}/rotate`);
    }
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith("/api/tokens/") &&
      !url.pathname.slice("/api/tokens/".length).includes("/") &&
      url.pathname.length > "/api/tokens/".length
    ) {
      const id = url.pathname.slice("/api/tokens/".length);
      return handleTokensApi(request, env, `/tokens/${encodeURIComponent(id)}`);
    }
    return new Response("Not Found", { status: 404 });
  },
};
