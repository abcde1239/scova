import * as tables from '@scova/db';
import { and, eq, inArray } from '@scova/db';
import { randomUUID } from 'node:crypto';
import { createDatabaseClient, connectDatabase, closeDatabase } from '@scova/db';
import { createObservedDatabase } from './support/query-observer.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createDefaultServices } from '../src/app/services.ts';
import { createNotificationService } from '../src/service/notifications.ts';
import { createReportService } from '../src/service/reports.ts';
import { historyFixture, seedHistoryRows } from './support/history-fixture.ts';

const fixture = historyFixture();
// A separate native pool commits the concurrent read-status change.
const writer = createDatabaseClient({ connectionString: fixture.databaseUrl });
beforeAll(async () => {
    await fixture.setup();
    await connectDatabase(writer);
}, 120_000);
afterAll(async () => {
    await closeDatabase(writer);
    await fixture.cleanup();
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function within<T>(promise: Promise<T>, description: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(description)), 5_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe('列表ID选择与DTO加载使用同一个PG快照', () => {
    it.each(['notifications', 'inbox'] as const)(
        '%s：hydration前另一连接标已读，不漏筛或提前结束后续分页',
        async (target) => {
            const owner = await fixture.register();
            const data = await seedHistoryRows(fixture.db, owner, 1, 5);
            const notificationIds = data.reports.map(() => randomUUID());
            await fixture.db
                .insert(tables.notifications)
                .values(
                    data.reports.map((report, index) => ({
                        id: notificationIds[index]!,
                        userId: owner.id,
                        runId: report.runId,
                        reportId: report.id,
                        kind: index === 4 ? ('summary' as const) : ('run_issue' as const),
                    })),
                )
                .returning({ id: tables.notifications.id })
                .then((rows) => ({ count: rows.length }));
            const allIds =
                target === 'notifications' ? notificationIds : data.inbox.map((row) => row.id);
            // Preserve submillisecond differences to exercise the database anchor as well.
            for (const [index, id] of allIds.entries()) {
                const timestamp = '2026-02-01T00:00:00.12345' + (6 - index) + 'Z';
                if (target === 'notifications')
                    await fixture.db.$client.query(
                        'UPDATE notifications SET created_at=$1::timestamptz WHERE id=$2::uuid',
                        [timestamp, id],
                    );
                else
                    await fixture.db.$client.query(
                        'UPDATE inbox_items SET created_at=$1::timestamptz WHERE id=$2::uuid',
                        [timestamp, id],
                    );
            }
            const expectedIds = target === 'notifications' ? allIds.slice(0, 4) : allIds;
            const entered = deferred(),
                release = deferred();
            let armed = true;
            async function beforeHydration(model: 'notifications' | 'inbox') {
                if (!armed || model !== target) return;
                armed = false;
                entered.resolve();
                await release.promise;
            }
            // Gate the real hydration SQL after ID selection established its snapshot.
            const reader = createObservedDatabase(fixture.databaseUrl, {
                async before(query) {
                    if (!query.text.includes('"read_at"')) return;
                    if (/\bfrom\s+"notifications"/i.test(query.text))
                        await beforeHydration('notifications');
                    else if (/\bfrom\s+"inbox_items"/i.test(query.text))
                        await beforeHydration('inbox');
                },
            });
            const services = createDefaultServices({
                db: () => reader,
                close: async () => {},
            });
            const notifications = createNotificationService(services);
            const reports = createReportService(services);
            const page = (query: {
                limit: number;
                cursor?: string;
            }): Promise<{
                items: { id: string; readAt: string | null; kind?: string }[];
                nextCursor: string | null;
            }> =>
                target === 'notifications'
                    ? notifications.list(owner.id, { ...query, kind: 'run_issue', unread: true })
                    : reports.inbox(owner.id, { ...query, unread: true });
            const pending = page({ limit: 1 });
            void pending.catch(() => undefined);
            try {
                await within(entered.promise, 'List did not reach the real hydration query');
                const marked = expectedIds.slice(0, 2);
                if (target === 'notifications') {
                    const changed = await writer
                        .update(tables.notifications)
                        .set({ readAt: new Date() })
                        .where(
                            and(
                                eq(tables.notifications.userId, owner.id),
                                inArray(tables.notifications.id, marked),
                            ),
                        )
                        .returning()
                        .then((rows) => ({ count: rows.length }));
                    expect(changed.count).toBe(2);
                } else {
                    const changed = await writer
                        .update(tables.inboxItems)
                        .set({ readAt: new Date() })
                        .where(
                            and(
                                eq(tables.inboxItems.userId, owner.id),
                                inArray(tables.inboxItems.id, marked),
                            ),
                        )
                        .returning()
                        .then((rows) => ({ count: rows.length }));
                    expect(changed.count).toBe(2);
                }
                // The write is committed before hydration resumes. RepeatableRead must
                // retain both the page item and its lookahead from the earlier SELECT.
                release.resolve();
                const first = await within(
                    pending,
                    'List did not finish after hydration was released',
                );
                expect(first.items.map((item) => item.id)).toEqual([expectedIds[0]]);
                expect(first.items.every((item) => item.readAt === null)).toBe(true);
                expect(first.nextCursor).toBeTruthy();
                if (target === 'notifications')
                    expect(
                        first.items.every((item) => 'kind' in item && item.kind === 'run_issue'),
                    ).toBe(true);

                // A later request sees the committed flags. The now-read anchor remains
                // valid, and lower microsecond rows must still be reachable.
                const fresh = await page({ limit: 100 });
                expect(fresh.items.map((item) => item.id)).toEqual(expectedIds.slice(2));
                expect(fresh.items.every((item) => item.readAt === null)).toBe(true);
                const continued: string[] = [];
                let cursor = first.nextCursor;
                for (let index = 0; cursor && index < 10; index++) {
                    const next = await page({ limit: 1, cursor });
                    continued.push(...next.items.map((item) => item.id));
                    expect(next.items.every((item) => item.readAt === null)).toBe(true);
                    cursor = next.nextCursor;
                }
                expect(cursor).toBeNull();
                expect(continued).toEqual(expectedIds.slice(2));
                expect(new Set(continued).size).toBe(continued.length);
            } finally {
                release.resolve();
                await pending.catch(() => undefined);
                await services.close();
                await closeDatabase(reader);
            }
        },
        20_000,
    );
});
