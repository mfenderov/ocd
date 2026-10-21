import { afterEach, beforeEach } from "vitest";

// The suite never talks to the network. A test that needs an outbound
// fetch installs its own stub (and says so); anything else that reaches
// out fails loudly instead of hitting the real Bot API — the Telegram
// token in the test env is a fake, but a real call is still a real call.
//
// The stub lives here, not in the test files: the brain's Telegram
// settings are bound in vitest.config.ts (so the /tg route can be
// driven end to end), and every code path that owns a message would
// otherwise try to send one.
const original = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`the test suite made an outbound fetch: ${String(input)}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = original;
});
