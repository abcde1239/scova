import { randomBytes, randomUUID } from 'node:crypto';
import { test as base } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Report, Run, TaskConfig } from '@scova/models';
import { scenarioData } from '../../../apps/worker/tests/support/acceptance-scenario-fixtures.ts';
import { ComposeEnvironment } from './compose.ts';
import type { Phase, Scenario } from './compose.ts';
import type { Images } from './compose.ts';

export type Owner = { context: BrowserContext; page: Page; id: string; csrf: string };
export type PreparedReport = {
    run: Run;
    report: Report;
    provenance: 'executed-supplier-fixture';
    remoteResearch: false;
};

export class BrowserEnvironment {
    readonly owners: Owner[] = [];
    constructor(
        readonly services: ComposeEnvironment,
        private browser: Browser,
    ) {}

    async owner() {
        const context = await this.browser.newContext({ baseURL: this.services.origin });
        try {
            const page = await context.newPage();
            await page.goto('/tasks');
            const credentials = {
                email: `${randomUUID()}@example.test`,
                password: randomBytes(24).toString('hex'),
                defaultTimezone: 'UTC',
            };
            const registered = await page.evaluate(async (credentials) => {
                const response = await fetch('/api/v1/auth/register', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(credentials),
                    signal: AbortSignal.timeout(10_000),
                });
                if (response.status !== 201)
                    throw new Error(`E2E register: HTTP ${response.status}`);
                return response.json() as Promise<{ user: { id: string }; csrfToken: string }>;
            }, credentials);
            const owner = { context, page, id: registered.user.id, csrf: registered.csrfToken };
            const cookies = await context.cookies();
            if (
                !cookies.some(
                    (cookie) => cookie.name === 'scova_session' && cookie.secure && cookie.httpOnly,
                )
            )
                throw new Error('E2E browser did not accept Secure/HttpOnly Cookie on localhost');
            await page.goto('/tasks');
            this.owners.push(owner);
            return owner;
        } catch (error) {
            await context.close();
            throw error;
        }
    }

    async request<T>(
        owner: Owner,
        path: string,
        options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) {
        const response = await this.response(owner, path, options);
        if (response.status < 200 || response.status >= 300)
            throw new Error(`E2E ${path}: HTTP ${response.status}`);
        return response.body as T;
    }

    async response(
        owner: Owner,
        path: string,
        options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) {
        if (!path.startsWith('/api/v1/') || path.includes('://'))
            throw new Error('E2E requests must use same-origin API paths');
        return owner.page.evaluate(
            async ({ path, csrf, options }) => {
                const response = await fetch(path, {
                    method: options.method ?? 'GET',
                    headers: {
                        'content-type': 'application/json',
                        'x-csrf-token': csrf,
                        ...options.headers,
                    },
                    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
                    signal: AbortSignal.timeout(10_000),
                });
                return { status: response.status, body: (await response.json()) as unknown };
            },
            { path, csrf: owner.csrf, options },
        );
    }

    config(name: Scenario = 'english'): TaskConfig {
        return {
            title: `${name} E2E fixture`,
            topic: name,
            goal: `Track ${name} original sources`,
            focusPoints: [],
            exclusions: [],
            sourcePreferences: {
                preferredUrls: [scenarioData(name, 'A').changedUrl],
                excludedUrls: [],
                officialOnly: false,
            },
            timeRange: { kind: 'rolling', days: 7 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            outputFormat: 'brief',
            budget: {
                maxSearches: 10,
                maxPages: 20,
                maxDurationSeconds: 120,
                maxInputTokens: 40000,
                maxOutputTokens: 8000,
            },
            notificationPreference: { mode: 'summary', runIssues: true },
        };
    }

    async task(owner: Owner, config = this.config()) {
        return (
            await this.request<{ task: { id: string } }>(owner, '/api/v1/tasks', {
                method: 'POST',
                body: { config },
            })
        ).task;
    }

    async execute(owner: Owner, taskId: string, mode: 'live') {
        const created = await this.request<{ run: Run }>(owner, `/api/v1/tasks/${taskId}/runs`, {
            method: 'POST',
            body: { mode },
            headers: { 'idempotency-key': randomUUID() },
        });
        const deadline = Date.now() + 90_000;
        for (;;) {
            const run = await this.request<Run>(owner, `/api/v1/runs/${created.run.id}`);
            if (run.status === 'failed' || run.status === 'canceled')
                throw new Error(`E2E Run terminated: ${run.status}/${run.failureCode}`);
            if (run.status === 'succeeded' || run.status === 'partial') {
                const list = await this.request<{ items: { id: string }[] }>(
                    owner,
                    `/api/v1/reports?taskId=${taskId}`,
                );
                for (const item of list.items) {
                    const report = await this.request<Report>(owner, `/api/v1/reports/${item.id}`);
                    if (report.runId === run.id) {
                        if (!report.evidence.length || report.mode !== mode)
                            throw new Error('E2E report did not pass real delivery');
                        return { run, report };
                    }
                }
            }
            if (Date.now() >= deadline) throw new Error('E2E Run delivery timed out');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    /** Runs actual Agent/ledger/reader/delivery with fixed supplier replies; no remote research. */
    async researchFixture(
        owner: Owner,
        taskId: string,
        scenario: Scenario,
        phase: Phase,
    ): Promise<PreparedReport> {
        await this.services.useScenario(scenario, phase);
        return {
            ...(await this.execute(owner, taskId, 'live')),
            provenance: 'executed-supplier-fixture',
            remoteResearch: false,
        };
    }

    /** Results for later presentation specs, generated through delivery rather than row insertion. */
    async prepareDisplay(owner: Owner, scenario: Scenario) {
        const task = await this.task(owner, this.config(scenario));
        const first = await this.researchFixture(owner, task.id, scenario, 'A');
        const second = await this.researchFixture(owner, task.id, scenario, 'B');
        return {
            purpose: 'prepared-display' as const,
            remoteResearch: false as const,
            task,
            rounds: [first, second] as const,
        };
    }

    async close() {
        const results = await Promise.allSettled(this.owners.map((owner) => owner.context.close()));
        if (results.some((result) => result.status === 'rejected'))
            throw new Error('E2E browser context cleanup failed');
    }
}

export const test = base.extend<{ environment: BrowserEnvironment }, { images: Images }>({
    images: [
        async ({ playwright }, use) => {
            void playwright;
            const builder = new ComposeEnvironment();
            try {
                await builder.build();
                await use(builder.images);
            } finally {
                await builder.stop();
                await builder.removeImages();
            }
        },
        { scope: 'worker', timeout: 960_000 },
    ],
    environment: [
        async ({ images, browser }, use, info) => {
            const services = new ComposeEnvironment(images);
            const environment = new BrowserEnvironment(services, browser);
            try {
                await services.start();
                await use(environment);
            } finally {
                try {
                    await environment.close();
                } finally {
                    await services.stop();
                }
                await info.attach('isolated-environment-cleanup', {
                    body: JSON.stringify({
                        project: services.project,
                        schema: services.schema,
                        checkpointSchema: services.checkpointSchema,
                        queue: services.queue,
                        resources: await services.resources(),
                    }),
                    contentType: 'application/json',
                });
            }
        },
        { timeout: 240_000 },
    ],
});
export { expect } from '@playwright/test';
