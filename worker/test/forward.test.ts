import { describe, expect, it } from "vitest";
import app, { forwardToDo, type Env } from "../src/index";

interface ForwardedCall {
  method: string;
  path: string;
  body: string;
  auth: string | null;
}

// Fake DO namespace whose stub records exactly what the Worker forwarded.
function recordingEnv(calls: ForwardedCall[]): Env {
  return {
    FLEET_STATE: {
      idFromName: () => ({}) ,
      get: () => ({
        fetch: async (req: Request | string) => {
          const inner = req as Request;
          const url = new URL(inner.url);
          calls.push({
            method: inner.method,
            path: url.pathname,
            body: await inner.text(),
            auth: inner.headers.get("authorization"),
          });
          return new Response("stub-ok");
        },
      }),
    },
  } as unknown as Env;
}

const BODY = JSON.stringify({ confirm: true });

// Every plain-passthrough route must forward method + mapped DO path +
// body + headers verbatim through the one shared helper. Table pins the
// current contract (query strings are not forwarded on these routes).
const CASES: Array<{ method: string; apiPath: string; doPath: string; body?: string }> = [
  { method: "POST", apiPath: "/api/revoke-all", doPath: "/revoke-all", body: BODY },
  { method: "POST", apiPath: "/api/backends/box-1/revoke", doPath: "/revoke/box-1", body: BODY },
  // Pre-existing wart, pinned not fixed: an already-encoded id is encoded
  // again (slice sees the raw %20, encodeURIComponent escapes the %).
  { method: "POST", apiPath: "/api/backends/b%20x/revoke", doPath: "/revoke/b%2520x", body: BODY },
  { method: "POST", apiPath: "/api/tokens", doPath: "/tokens", body: "{}" },
  { method: "POST", apiPath: "/api/tokens/t-1/rotate", doPath: "/tokens/t-1/rotate", body: "{}" },
  { method: "DELETE", apiPath: "/api/tokens/t-1", doPath: "/tokens/t-1" },
  { method: "POST", apiPath: "/api/heartbeat", doPath: "/heartbeat", body: BODY },
];

describe("shared DO passthrough", () => {
  it("all plain routes forward method + path + body + headers unchanged", async () => {
    for (const c of CASES) {
      const calls: ForwardedCall[] = [];
      const res = await app.fetch(
        new Request(`https://fleet.local${c.apiPath}`, {
          method: c.method,
          headers: { "content-type": "application/json", authorization: "Bearer probe" },
          body: c.body,
        }),
        recordingEnv(calls),
      );
      expect(await res.text()).toBe("stub-ok");
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe(c.method);
      expect(calls[0].path).toBe(c.doPath);
      expect(calls[0].body).toBe(c.body ?? "");
      expect(calls[0].auth).toBe("Bearer probe");
    }
  });

  it("forwardToDo fails loud when the FLEET_STATE binding is missing", async () => {
    const res = await forwardToDo(new Request("https://fleet.local/api/tokens", { method: "POST" }), undefined, "/tokens");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("FLEET_STATE");
  });
});
