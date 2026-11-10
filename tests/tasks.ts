export const verificationTasks = {
    // Root-only verification commands live here instead of enlarging the root package manifest.
    // They remain addressable through `vp run <task>` for harness and focused checks.
    'test:search:live': { command: 'vpx scripts/smoke-search.ts --live', cache: false },
    'test:reader:browser': {
        command: 'vp test --config tests/reader-browser.vite.config.ts',
        cache: false,
    },
    'test:reader:runtime': {
        command: [
            'vpx scripts/reader-runtime.ts',
            'vpx scripts/run-bun.mjs scripts/reader-runtime.ts',
        ],
        cache: false,
    },
    'test:search:read': { command: 'vpx scripts/smoke-search.ts --live --read', cache: false },
    'test:connectors:tavily': {
        command: 'vpx scripts/smoke-connectors.ts --live --provider=tavily',
        cache: false,
    },
    'test:connectors:runtime': {
        command: [
            'vpx scripts/connectors-runtime.ts',
            'vpx scripts/run-bun.mjs scripts/connectors-runtime.ts',
        ],
        cache: false,
    },
    'test:connectors:live': { command: 'vpx scripts/smoke-connectors.ts --live', cache: false },
    'test:connectors:reader': {
        command: 'vpx scripts/smoke-connectors.ts --reader-only',
        cache: false,
    },
    'test:processes': { command: 'vpx scripts/smoke-processes.mjs', cache: false },
    'test:runtime': {
        command: 'vpx scripts/run-bun.mjs scripts/runtime-test.mjs',
        cache: false,
    },
    'test:runtime:node': { command: 'vpx scripts/runtime-test.mjs', cache: false },
    'test:database': {
        command: 'vp test --config tests/database.vite.config.ts',
        cache: false,
    },
    'test:auth': { command: 'vp test --config tests/auth.vite.config.ts', cache: false },
    'test:integration': {
        command: [
            'vp run test:database',
            'vp run test:auth',
            'vp test --config tests/tasks.vite.config.ts',
            'vp run test:task-drafts',
            'vp run test:questions',
            'vp test --config tests/runs.vite.config.ts',
            'vp run test:reports',
            'vp run test:library',
            'vp run test:notifications',
            'vp run test:sse',
            'vp test --config tests/backend-flow.vite.config.ts',
            'vp run test:worker',
            'vp run test:e2e:backend',
        ],
        cache: false,
    },
    'test:library': { command: 'vp test --config tests/library.vite.config.ts', cache: false },
    'test:task-drafts': {
        command: 'vp test --config tests/task-drafts.vite.config.ts',
        cache: false,
    },
    'test:reports': { command: 'vp test --config tests/reports.vite.config.ts', cache: false },
    'test:delivery': {
        command:
            'vp test --config tests/worker-outbox.vite.config.ts apps/worker/tests/delivery.integration.test.ts',
        cache: false,
    },
    'test:feedback': {
        command:
            'vp test --config tests/worker-outbox.vite.config.ts apps/worker/tests/feedback.integration.test.ts',
        cache: false,
    },
    'test:worker': {
        command: 'vp test --config tests/worker-outbox.vite.config.ts',
        cache: false,
    },
    'test:agent-recovery': {
        command:
            'vp test --config tests/worker-outbox.vite.config.ts apps/worker/tests/recovery.integration.test.ts',
        cache: false,
    },
    'test:notifications': {
        command: 'vp test --config tests/notifications.vite.config.ts',
        cache: false,
    },
    'test:sse': { command: 'vp test --config tests/sse.vite.config.ts', cache: false },
    'test:questions': {
        command: 'vp test --config tests/report-questions.vite.config.ts',
        cache: false,
    },
    'test:e2e:backend': {
        command: 'vp test --config tests/acceptance.vite.config.ts',
        cache: false,
    },
    'test:e2e': {
        command: 'playwright test --config tests/e2e/playwright.config.ts',
        cache: false,
    },
    'test:e2e:install': { command: 'playwright install chromium', cache: false },
    'test:operations': {
        command: 'vp test --config tests/operations.vite.config.ts',
        cache: false,
    },
    'test:deployment': { command: 'node scripts/smoke-deployment.mjs', cache: false },
};
