import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite never talks to the network (see test/setup.ts).
    setupFiles: ["./test/setup.ts"],
    // The tools have their own suite, in node: they read files, and the
    // Workers runtime has no filesystem. The defaults are kept — naming
    // an exclude replaces them.
    exclude: ["**/node_modules/**", "**/.git/**", "tools/**"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Test-only bindings: wrangler.toml ships no ACCESS_* defaults
      // (unset = deny-all fail-closed in prod), so the valid-JWT tests
      // inject them here. This file never deploys — these values must never
      // go live.
      //
      // The brain's Telegram settings are here for the same reason: the
      // brain's front door (/tg) can only be driven end to end when the
      // brain is configured. The token is a fake, so a test that reaches
      // the real Bot API would fail there — the tests that drive /tg use
      // an update that answers nothing.
      //
      // The seal secret lets the brain read a box's admin token, so the
      // relays run for real: a box with no sealed admin token is the
      // misconfiguration the brain's own presence probe must refuse to
      // judge. A box sealed with another key cannot be read either.
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-access-aud-tag",
          ACCESS_ALLOWED_EMAIL: "owner@example.com",
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          TELEGRAM_OWNER_CHAT_ID: "7",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
          ADMIN_SEAL_SECRET: "test-admin-seal-secret",
        },
      },
    }),
  ],
});
