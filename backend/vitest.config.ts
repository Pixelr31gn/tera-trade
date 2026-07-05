import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    env: {
      // Unit tests need config.ts's zod schema to parse successfully but
      // never actually touch a database unless TEST_DATABASE_URL is set
      // (see tests/engineIntegration.test.ts).
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test",
      API_KEY: "test-key",
    },
  },
});
