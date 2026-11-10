import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';
export default defineConfig({
    root: fileURLToPath(new URL('../', import.meta.url)),
    resolve: { tsconfigPaths: true },
    test: {
        include: ['apps/server/tests/avatar.integration.test.ts'],
        testTimeout: 30_000,
        fileParallelism: false,
    },
});
