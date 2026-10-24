import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  test: { include: ["apps/api/tests/tasks.integration.test.ts"], testTimeout: 30_000 },
});
