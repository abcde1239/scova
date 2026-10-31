import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({
    ...base,
    testMatch: 'execution.spec.ts',
    outputDir: '../../artifacts/execution/results',
    use: { ...base.use, baseURL: 'http://127.0.0.1:5219' },
    webServer: {
        command:
            'vp run web#build:e2e && vp run web#preview -- --host 127.0.0.1 --port 5219 --strictPort',
        cwd: '../..',
        url: 'http://127.0.0.1:5219/tasks',
        reuseExistingServer: false,
        timeout: 120_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
});
