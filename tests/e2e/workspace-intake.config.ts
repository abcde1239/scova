import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: 'workspace-intake.spec.ts',
    outputDir: '../../artifacts/e2e/workspace-intake',
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:4197',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], channel: process.env.SCOVA_TEST_BROWSER_CHANNEL },
        },
    ],
    webServer: {
        command:
            'vp build --outDir ../../artifacts/e2e/workspace-intake-web && vp preview --host 127.0.0.1 --port 4197 --strictPort --outDir ../../artifacts/e2e/workspace-intake-web',
        cwd: '../../apps/web',
        url: 'http://127.0.0.1:4197/',
        reuseExistingServer: false,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        timeout: 120_000,
    },
});
