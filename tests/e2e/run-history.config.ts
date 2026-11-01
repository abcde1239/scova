import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({
    ...base,
    testMatch: 'run-history.spec.ts',
    outputDir: '../../artifacts/run-history/results',
    use: { ...base.use, baseURL: 'http://127.0.0.1:5221' },
    webServer: {
        cwd: '../..',
        command: 'vp run web#build && vp run web#preview --host 127.0.0.1 --port 5221 --strictPort',
        url: 'http://127.0.0.1:5221/tasks',
        reuseExistingServer: false,
        timeout: 120000,
    },
});
