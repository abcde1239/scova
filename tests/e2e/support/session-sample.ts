import type { Page } from '@playwright/test';

/** Component fixtures have a fixed account response and never require a running API. */
export async function mockFixtureSession(page: Page) {
    await page.route('**/api/v1/me', (route) =>
        route.fulfill({
            json: {
                user: {
                    id: '00000000-0000-4000-8000-000000000001',
                    email: 'fixture@example.test',
                    createdAt: '2026-10-31T00:00:00Z',
                    preferences: {
                        defaultTimezone: 'UTC',
                        notificationPreference: { mode: 'summary', runIssues: true },
                    },
                },
                csrfToken: 'fixture-only',
            },
        }),
    );
}
