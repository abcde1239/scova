import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.ts',
    outputDir: '../../artifacts/e2e/results',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:4189',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command:
            'vp run web#build && vp run web#preview -- --host 127.0.0.1 --port 4189 --strictPort',
        cwd: '../..',
        url: 'http://127.0.0.1:4189/tasks',
        reuseExistingServer: false,
        timeout: 120_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
});
