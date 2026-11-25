import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    root: fileURLToPath(new URL('../', import.meta.url)),
    test: {
        include: ['apps/server/tests/project-threads.integration.test.ts'],
        testTimeout: 30_000,
    },
});
