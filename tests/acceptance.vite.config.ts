import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  root: fileURLToPath(new URL("../", import.meta.url)),
  test: {
    include: ["apps/server/tests/acceptance-*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
