import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Test-only Access config: wrangler.toml ships no ACCESS_* defaults
      // (unset = deny-all fail-closed in prod), so the valid-JWT tests
      // inject them here. This file never deploys — these values must never
      // go live.
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-access-aud-tag",
          ACCESS_ALLOWED_EMAIL: "owner@example.com",
        },
      },
    }),
  ],
});
