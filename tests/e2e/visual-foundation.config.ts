import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({
    ...base,
    testMatch: 'visual-foundation.spec.ts',
    outputDir: '../../artifacts/visual-foundation/results',
    use: { ...base.use, baseURL: 'http://127.0.0.1:4195', viewport: { width: 1280, height: 1000 } },
    webServer: {
        command:
            'vp run web#build:e2e && vp run web#preview -- --host 127.0.0.1 --port 4195 --strictPort',
        cwd: '../..',
        url: 'http://127.0.0.1:4195/tasks',
        reuseExistingServer: false,
        timeout: 120_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
});
