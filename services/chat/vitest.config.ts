import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@design": path.resolve(here, "../../design"),
      "@branding": path.resolve(here, "../../branding"),
    },
  },
  define: { __APP_VERSION__: JSON.stringify("test") },
  test: {
    include: ["test/unit/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["test/unit/setup.ts"],
  },
});
