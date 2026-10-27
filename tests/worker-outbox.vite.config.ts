import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    root: fileURLToPath(new URL('../', import.meta.url)),
    test: {
        include: ['apps/worker/tests/*.integration.test.ts'],
        fileParallelism: false,
        testTimeout: 30_000,
    },
});
