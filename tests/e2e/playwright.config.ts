import { defineConfig, devices } from '@playwright/test';

const fullStackSpecs = [
    'environment.spec.ts',
    'two-rounds-english.spec.ts',
    'two-rounds-admission.spec.ts',
    'two-rounds-research.spec.ts',
    'browser-resilience.spec.ts',
    'base-pages-accessibility.spec.ts',
    'supplementary-visual.spec.ts',
    'full-workbench.spec.ts',
];
const fullStack =
    process.env.SCOVA_E2E_FULL_STACK === '1' ||
    process.argv.some((argument) => fullStackSpecs.some((name) => argument.includes(name)));
// Playwright reevaluates config in workers, whose argv no longer contains the spec path.
if (fullStack) process.env.SCOVA_E2E_FULL_STACK = '1';

export default defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.ts',
    testIgnore: fullStack ? '**/shell.spec.ts' : fullStackSpecs.map((name) => `**/${name}`),
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
              command: 'vp run web#build:e2e && vpx tests/e2e/serve.mjs',
              cwd: '../..',
              url: 'http://127.0.0.1:4189/tasks',
              reuseExistingServer: false,
              timeout: 120_000,
              gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
          },
});
