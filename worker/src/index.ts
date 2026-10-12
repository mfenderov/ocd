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

export default {
  async fetch(request: Request, env?: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/backends") {
      return handleBackends(env);
    }
    return new Response("Not Found", { status: 404 });
  },
};
