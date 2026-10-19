// Box API paths the Worker calls on an enrolled box.
//
// The prefix avoids "/admin" on purpose: Cloudflare's managed WAF rules
// challenge any path containing that segment (a WordPress-admin
// heuristic), and the challenge page answers instead of the box — which
// broke every worker→box relay. A path the edge does not second-guess
// keeps the relay working; the endpoints stay bearer-gated either way.
export const BOX_API = {
  mint: "/_oc/mint",
  revoke: "/_oc/revoke",
  audit: "/_oc/audit",
} as const;
