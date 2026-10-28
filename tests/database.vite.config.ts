import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    root: fileURLToPath(new URL('../', import.meta.url)),
    test: {
        include: [
            'apps/server/tests/database.integration.test.ts',
            'packages/db/tests/migrations.integration.test.ts',
        ],
        testTimeout: 120_000,
        hookTimeout: 120_000,
        fileParallelism: false,
    },
});
