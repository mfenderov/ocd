// The box's HTTP client: the one place the brain reaches a box.
//
// Every outbound box call goes through here: resolve the pinned
// hostname, build the URL, fetch. A heartbeat-supplied URL can never
// reach fetch — the hostname always comes from the registry the brain
// built from the rows it enrolled.
//
// The client speaks HTTP, so it lives with the adapters (telegram.ts,
// dns.ts) and not in the domain. The domain asks a box for things in
// its own words; the adapter above this module says how the box hears
// it.
import type { BoxRow } from "./boxes";

// Pinned-host registry: box id -> enrolled-time hostname. Build from
// listBackends()/listBoxes() rows; every future outbound box call must
// resolve through this, never through heartbeat-supplied URLs (SSRF rule).
export function pinnedRegistry(rows: Array<Pick<BoxRow, "id" | "hostname">>): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.hostname]));
}

export function pinnedHostname(registry: Map<string, string>, boxId: string): string {
  const hostname = registry.get(boxId);
  if (!hostname) {
    throw new Error(`refused: unknown box "${boxId}" (no pinned hostname)`);
  }
  return hostname;
}

function boxUrl(hostname: string, path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("refused: box path must be absolute");
  }
  return `https://${hostname}${path}`;
}

function assertPinnedHost(registry: Map<string, string>, hostname: string): void {
  for (const pinned of registry.values()) {
    if (hostname === pinned) {
      return;
    }
  }
  throw new Error(`refused: hostname "${hostname}" is not pinned`);
}

// Fetch a raw URL only when its hostname is in the pinned registry.
export async function fetchUrlPinned(
  registry: Map<string, string>,
  url: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error("refused: invalid box URL");
  }
  assertPinnedHost(registry, hostname);
  return fetcher(url, init);
}

// Choke point for ALL outbound box calls: resolve the pinned hostname,
// build the URL, fetch. Heartbeat-supplied URLs can never reach fetch.
export async function fetchBox(
  registry: Map<string, string>,
  boxId: string,
  path: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return fetchUrlPinned(registry, boxUrl(pinnedHostname(registry, boxId), path), init, fetcher);
}
