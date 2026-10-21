import { runInDurableObject } from "cloudflare:test";
import type { DurableObjectStub } from "@cloudflare/workers-types";
import type { FleetState } from "../src/state";

/**
 * inState runs a callback against the live FleetState instance.
 *
 * The Vitest plugin's runInDurableObject only infers the instance type for
 * RPC-branded Durable Objects; ours is a plain DurableObject, so the
 * type is supplied here once instead of at every call site.
 */
export function inState<R>(
  stub: DurableObjectStub,
  fn: (state: FleetState) => R | Promise<R>,
): Promise<R> {
  // Annotating the callback parameter lets TypeScript infer the instance
  // type; the branded overload does not apply to a plain DurableObject.
  return runInDurableObject(stub, async (instance: FleetState) => fn(instance));
}

/**
 * The URL a fetch call names.
 *
 * A Request carries its own URL, a string is one, and a URL stringifies
 * to itself. Nothing here is stringified blindly: a Request would read
 * as "[object Request]".
 */
export function requestedUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}
