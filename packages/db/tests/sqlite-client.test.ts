import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { closeDatabase, eq, isUniqueConflict, sessions, users } from '../src/index.ts';
import { createSqliteDatabaseClient } from '../src/sqlite-client.ts';

it('persists defaults, joins and rollback in a native SQLite file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scova-sqlite-client-'));
    const path = join(directory, 'business.sqlite');
    let db = createSqliteDatabaseClient(path);
    try {
        const account = {
            email: 'first@example.test',
            normalizedEmail: 'first@example.test',
            passwordHash: 'test',
        };
        const [user] = await db.insert(users).values(account).returning();
        expect(user).toMatchObject({
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
            createdAt: expect.any(Date),
        });
        await expect(db.insert(users).values(account)).rejects.toSatisfy(isUniqueConflict);
        const expiresAt = new Date('2031-01-01T01:02:03.004Z');
        const session = {
            userId: user.id,
            tokenHash: 'a'.repeat(64),
            csrfTokenHash: 'b'.repeat(64),
            expiresAt,
        };
        await expect(
            db.transaction(async (tx) => {
                await tx.insert(sessions).values(session);
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');
        expect(await db.query.sessions.findMany()).toEqual([]);
        await db.insert(sessions).values(session);
        await closeDatabase(db);
        db = createSqliteDatabaseClient(path);
        expect(
            await db.query.sessions.findFirst({
                where: eq(sessions.userId, user.id),
                with: { owner: true },
            }),
        ).toMatchObject({ owner: user, expiresAt });
    } finally {
        await closeDatabase(db);
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
        rmdirSync(directory);
    }
});
