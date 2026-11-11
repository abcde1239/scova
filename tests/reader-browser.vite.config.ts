import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    root: fileURLToPath(new URL('../', import.meta.url)),
    test: {
        include: ['packages/connectors/tests/reader-*.integration.test.ts'],
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
