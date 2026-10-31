import { defineConfig, devices } from '@playwright/test';

const fullStack =
    process.env.SCOVA_E2E_FULL_STACK === '1' ||
    process.argv.some((argument) => argument.includes('environment.spec.ts'));
// Playwright reevaluates config in workers, whose argv no longer contains the spec path.
if (fullStack) process.env.SCOVA_E2E_FULL_STACK = '1';

export default defineConfig({
    testDir: '.',
    testMatch: fullStack ? '**/*.spec.ts' : '**/shell.spec.ts',
    testIgnore: fullStack ? '**/shell.spec.ts' : undefined,
    timeout: fullStack ? 600_000 : 30_000,
    outputDir: '../../artifacts/e2e/results',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    reporter: [['list'], ['json', { outputFile: '../../artifacts/e2e/report.json' }]],
    use: {
        baseURL: 'http://127.0.0.1:4189',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: fullStack
        ? undefined
        : {
              command:
                  'vp run web#build && vp run web#preview -- --host 127.0.0.1 --port 4189 --strictPort',
              cwd: '../..',
              url: 'http://127.0.0.1:4189/tasks',
              reuseExistingServer: false,
              timeout: 120_000,
              gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
          },
});
