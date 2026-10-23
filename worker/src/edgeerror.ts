// The edge's error pages: Cloudflare answering instead of the box.
//
// When a box's tunnel dies, the edge answers the brain's request itself:
// 530 "tunnel not connected" / "error 1016" / "error 1033", or a
// plain-text "error code: NNN" page on a status the box also uses. fetch
// resolves, so callers must check before trusting an answer.
//
// Pure and shared: the box reads (boxapi.ts) and the revoke (revoke.ts)
// both read it, and neither may guess alone. It lives here — not in the
// adapter that speaks HTTP, not in the domain that asks — so the domain
// can use it without depending on an adapter (see architecture.test.ts).
const EDGE_ERROR_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);

// isEdgeError tells an unreachable box from a box that answered. The
// status covers the tunnel errors; the body covers the edge's plain-text
// "error code: NNN" pages, which arrive on statuses the box also uses. A
// 5xx outside this set came from the box: the box answered and refused.
export function isEdgeError(status: number, body: string): boolean {
  return EDGE_ERROR_STATUSES.has(status) || /error code: \d+/.test(body);
}
