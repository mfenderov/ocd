// The brain's DNS writer: it lists the zone, creates the two CNAMEs a box
// needs, and moves them when the box's tunnel changes.
import { describe, expect, it } from "vitest";
import { ensureBoxDns, type BoxDns } from "../src/dns";
import { requestedUrl } from "./helpers";

const ZONE = "zone-1";
// The credential is a fake, but it looks like one on purpose: the writer
// must never put it (or the word) into an error message.
const TOKEN = "cf-dns-token-9";

const BOX: BoxDns = {
  tapHost: "oc-tap-mac.buyallmemes.com",
  uiHost: "oc-mac.buyallmemes.com",
  target: "tun-1.cfargotunnel.com",
};

interface CfCall {
  method: string;
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

interface CfRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

// The fake Cloudflare API: it keeps the zone's records and remembers every
// call, so a test can assert what the brain wrote.
class FakeCloudflare {
  calls: CfCall[] = [];
  records: CfRecord[];
  // Set to make every call answer with this status and API code.
  failWith: { status: number; code: number } | null = null;
  // Set to make the listing answer 200 with success:false — an envelope
  // that says the call failed while the status says it did not.
  listSaysFailure = false;
  // Set to make the listing answer 200 with a body that is not JSON.
  listIsGarbage = false;
  // Set to make a write answer 200 with success:false — the write did not
  // happen, whatever the status says.
  writeSaysFailure = false;
  // Set to make a write answer 200 with a body that is not the API's
  // envelope at all.
  writeIsGarbage = false;

  constructor(records: CfRecord[] = []) {
    this.records = records;
  }

  get fetcher(): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestedUrl(input));
      const method = (init?.method ?? "GET").toUpperCase();
      // The body is JSON text: the brain sends text, never a blob.
      const body = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : null;
      this.calls.push({
        method,
        url: url.toString(),
        auth: new Headers(init?.headers).get("authorization"),
        body,
      });
      if (this.failWith) {
        return Promise.resolve(
          this.reply(this.failWith.status, {
            success: false,
            errors: [{ code: this.failWith.code, message: "Unauthorized to access requested resource" }],
            result: null,
          }),
        );
      }
      if (method === "GET") {
        if (this.listSaysFailure) {
          return Promise.resolve(
            this.reply(200, {
              success: false,
              errors: [{ code: 1000, message: "the api refused the call" }],
              result: null,
            }),
          );
        }
        if (this.listIsGarbage) {
          return Promise.resolve(
            new Response("<html>gateway error</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
          );
        }
        // The API's default page size is 20: a zone with more records
        // than that answers with the first page only.
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = 20;
        const start = (page - 1) * perPage;
        return Promise.resolve(
          this.reply(200, {
            success: true,
            result: this.records.slice(start, start + perPage),
            result_info: {
              page,
              per_page: perPage,
              count: Math.min(perPage, Math.max(0, this.records.length - start)),
              total_count: this.records.length,
              total_pages: Math.max(1, Math.ceil(this.records.length / perPage)),
            },
          }),
        );
      }
      const record = { id: `rec-${this.records.length + 1}`, ...body } as CfRecord;
      if (this.writeSaysFailure) {
        return Promise.resolve(
          this.reply(200, {
            success: false,
            errors: [{ code: 81057, message: "the record already exists" }],
            result: null,
          }),
        );
      }
      if (this.writeIsGarbage) {
        return Promise.resolve(
          new Response("<html>gateway error</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      if (method === "POST") {
        this.records.push(record);
        return Promise.resolve(this.reply(200, { success: true, result: record }));
      }
      // PATCH: the record id is the last path segment.
      const id = url.pathname.split("/").pop();
      const index = this.records.findIndex((r) => r.id === id);
      if (index >= 0) {
        this.records[index] = { ...this.records[index], ...body };
      }
      return Promise.resolve(this.reply(200, { success: true, result: this.records[index] ?? null }));
    };
  }

  private reply(status: number, doc: unknown): Response {
    return new Response(JSON.stringify(doc), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

describe("the brain's DNS writer", () => {
  it("creates both CNAMEs when the zone has none for the box", async () => {
    const cf = new FakeCloudflare();
    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      BOX,
    );

    expect(outcome).toEqual({
      ok: true,
      created: ["oc-tap-mac.buyallmemes.com", "oc-mac.buyallmemes.com"],
      updated: [],
    });

    const posts = cf.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    // The Cloudflare v4 API: /zones/<zone>/dns_records under /client/v4.
    const gets = cf.calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(1);
    expect(gets[0].url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records`,
    );
    expect(posts.map((c) => c.url)).toEqual([
      `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records`,
      `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records`,
    ]);
    expect(posts.map((c) => c.body?.["name"])).toEqual([
      "oc-tap-mac.buyallmemes.com",
      "oc-mac.buyallmemes.com",
    ]);
    for (const post of posts) {
      expect(post.body).toMatchObject({
        type: "CNAME",
        content: "tun-1.cfargotunnel.com",
        proxied: true,
        ttl: 1,
      });
    }
    // Every call carries the credential, the listing included.
    for (const call of cf.calls) {
      expect(call.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("moves a record that points at an old tunnel, and never creates a second one", async () => {
    const cf = new FakeCloudflare([
      {
        id: "rec-1",
        name: "oc-tap-mac.buyallmemes.com",
        type: "CNAME",
        content: "old-tunnel.cfargotunnel.com",
        proxied: true,
        ttl: 1,
      },
    ]);

    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      BOX,
    );

    expect(outcome).toEqual({
      ok: true,
      created: ["oc-mac.buyallmemes.com"],
      updated: ["oc-tap-mac.buyallmemes.com"],
    });

    const patches = cf.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records/rec-1`,
    );
    expect(patches[0].body).toMatchObject({
      type: "CNAME",
      name: "oc-tap-mac.buyallmemes.com",
      content: "tun-1.cfargotunnel.com",
      proxied: true,
      ttl: 1,
    });
    expect(patches[0].auth).toBe(`Bearer ${TOKEN}`);

    // One record per name, now pointing at the new tunnel.
    const moved = cf.records.filter((r) => r.name === "oc-tap-mac.buyallmemes.com");
    expect(moved).toHaveLength(1);
    expect(moved[0].content).toBe("tun-1.cfargotunnel.com");
  });

  it("leaves both records alone when they already point at the tunnel", async () => {
    const cf = new FakeCloudflare([
      {
        id: "rec-1",
        name: "oc-tap-mac.buyallmemes.com",
        type: "CNAME",
        content: "tun-1.cfargotunnel.com",
        proxied: true,
        ttl: 1,
      },
      {
        id: "rec-2",
        name: "oc-mac.buyallmemes.com",
        type: "CNAME",
        content: "tun-1.cfargotunnel.com",
        proxied: true,
        ttl: 1,
      },
    ]);

    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      BOX,
    );

    expect(outcome).toEqual({ ok: true, created: [], updated: [] });
    expect(cf.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("finds the box's record on the zone's second page instead of creating a second one", async () => {
    const others = Array.from({ length: 20 }, (_, i) => ({
      id: `other-${i}`,
      name: `other-${i}.buyallmemes.com`,
      type: "CNAME",
      content: "other.cfargotunnel.com",
      proxied: true,
      ttl: 1,
    }));
    const cf = new FakeCloudflare([
      ...others,
      {
        id: "rec-last",
        name: "oc-tap-mac.buyallmemes.com",
        type: "CNAME",
        content: "old-tunnel.cfargotunnel.com",
        proxied: true,
        ttl: 1,
      },
    ]);

    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      BOX,
    );

    expect(outcome).toEqual({
      ok: true,
      created: ["oc-mac.buyallmemes.com"],
      updated: ["oc-tap-mac.buyallmemes.com"],
    });
    expect(cf.calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(cf.records.filter((r) => r.name === "oc-tap-mac.buyallmemes.com")).toHaveLength(1);
  });

  it("repairs a record that points at the tunnel but is not proxied", async () => {
    const cf = new FakeCloudflare([
      {
        id: "rec-1",
        name: "oc-tap-mac.buyallmemes.com",
        type: "CNAME",
        content: "tun-1.cfargotunnel.com",
        proxied: false,
        ttl: 1,
      },
    ]);

    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      BOX,
    );

    expect(outcome).toEqual({
      ok: true,
      created: ["oc-mac.buyallmemes.com"],
      updated: ["oc-tap-mac.buyallmemes.com"],
    });

    // The brain owns these records: a grey-cloud CNAME is repaired, not
    // trusted — it would answer from the origin, not from the edge.
    const patches = cf.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({
      type: "CNAME",
      name: "oc-tap-mac.buyallmemes.com",
      content: "tun-1.cfargotunnel.com",
      proxied: true,
      ttl: 1,
    });
  });

  it("stops when the listing says the call failed, instead of reading it as an empty zone", async () => {
    const cf = new FakeCloudflare();
    cf.listSaysFailure = true;

    let failure: unknown;
    try {
      await ensureBoxDns({ fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN }, BOX);
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("list");
    // Nothing was written: the writer did not mistake the zone for empty.
    expect(cf.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("stops when the listing is not JSON, instead of reading it as an empty zone", async () => {
    const cf = new FakeCloudflare();
    cf.listIsGarbage = true;

    let failure: unknown;
    try {
      await ensureBoxDns({ fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN }, BOX);
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("list");
    expect(cf.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("stops when a write says it refused, instead of counting a record that is not there", async () => {
    const cf = new FakeCloudflare();
    cf.writeSaysFailure = true;

    let failure: unknown;
    try {
      await ensureBoxDns({ fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN }, BOX);
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("refused");
    expect((failure as Error).message).toContain("81057");
  });

  it("stops when a write answers with something that is not the API's envelope", async () => {
    const cf = new FakeCloudflare();
    cf.writeIsGarbage = true;

    let failure: unknown;
    try {
      await ensureBoxDns({ fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN }, BOX);
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("refused");
  });

  it("writes one record when the box's two hosts are the same name", async () => {
    const cf = new FakeCloudflare();

    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      { ...BOX, uiHost: BOX.tapHost },
    );

    expect(outcome).toEqual({
      ok: true,
      created: ["oc-tap-mac.buyallmemes.com"],
      updated: [],
    });
    expect(cf.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("writes only the tap host when the box has no UI host", async () => {
    const cf = new FakeCloudflare();

    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      { ...BOX, uiHost: "" },
    );

    expect(outcome).toEqual({
      ok: true,
      created: ["oc-tap-mac.buyallmemes.com"],
      updated: [],
    });
    const posts = cf.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body?.["name"]).toBe("oc-tap-mac.buyallmemes.com");
  });

  it("fails loudly when the box has no tap host: that is a brain bug", async () => {
    const cf = new FakeCloudflare();

    let failure: unknown;
    try {
      await ensureBoxDns(
        { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
        { ...BOX, tapHost: "" },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("tap host");
    expect(cf.calls).toHaveLength(0);
  });

  it("names the 403 and the API code, and never the credential", async () => {
    const cf = new FakeCloudflare();
    cf.failWith = { status: 403, code: 9109 };

    let failure: unknown;
    try {
      await ensureBoxDns({ fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN }, BOX);
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("403");
    expect(message).toContain("9109");
    // The code is named with what it means: the credential may not write
    // this zone's DNS.
    expect(message).toContain("may not write the zone's DNS");
    expect(message).not.toContain(TOKEN);
    expect(message).not.toMatch(/token/i);
  });

  it("refuses to write a record with no target, without calling the API", async () => {
    const cf = new FakeCloudflare();

    const outcome = await ensureBoxDns(
      { fetcher: cf.fetcher, zoneId: ZONE, token: TOKEN },
      { ...BOX, target: "" },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome).toHaveProperty("reason", expect.stringContaining("no tunnel target"));
    expect(cf.calls).toHaveLength(0);
  });
});
