import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  root: fileURLToPath(new URL("../", import.meta.url)),
  test: {
    include: ["apps/server/tests/backend-flow.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
