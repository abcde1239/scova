import { describe, expect, it } from 'vite-plus/test';
import {
    closeDatabase,
    createDatabaseClient,
    databaseConnection,
    isUniqueConflict,
} from '../src/client.ts';
import { scopeMigrationSql } from '../src/migrate.ts';

describe('数据库连接和 SQL 边界', () => {
    it('空闲连接错误交由应用注入的处理器，不触发未处理事件', async () => {
        const errors: Error[] = [];
        const db = createDatabaseClient({
            connectionString: 'postgresql://u:p@localhost/db',
            onIdleError: (error) => {
                errors.push(error);
            },
        });
        const error = new Error('idle connection failure');
        try {
            expect(db.$client.emit('error', error)).toBe(true);
            expect(errors).toEqual([error]);
        } finally {
            await closeDatabase(db);
        }
    });
    it('显式转换 schema 并保留连接池与维护进程名称', () => {
        const config = databaseConnection({
            connectionString:
                'postgresql://u:p@localhost/db?schema=scova_test&application_name=scova-worker',
            max: 3,
        });
        const url = new URL(config.connectionString);
        expect(config.schema).toBe('scova_test');
        expect(config.max).toBe(3);
        expect(url.searchParams.has('schema')).toBe(false);
        expect(url.searchParams.get('options')).toBe('-c search_path=scova_test');
        expect(url.searchParams.get('application_name')).toBe('scova-worker');
        expect(() =>
            databaseConnection({
                connectionString: 'postgresql://u:p@localhost/db?schema=public;drop',
            }),
        ).toThrow('非法');
        expect(() =>
            databaseConnection({
                connectionString: 'postgresql://u:p@localhost/db?options=-c%20search_path=other',
            }),
        ).toThrow('search_path');
    });

    it('识别 Drizzle 包装的唯一冲突，错误 cause 环不会死循环', () => {
        expect(isUniqueConflict(new Error('query', { cause: { code: '23505' } }))).toBe(true);
        expect(isUniqueConflict({ code: '23503' })).toBe(false);
        const cyclic: { cause?: unknown } = {};
        cyclic.cause = cyclic;
        expect(isUniqueConflict(cyclic)).toBe(false);
    });

    it('仅重定向 Kit 的 public 标识符，不更改字面量、注释或函数正文', () => {
        expect(
            scopeMigrationSql(
                `CREATE TYPE "public"."X" AS ENUM ('"public".x'); -- "public".x\nSELECT $$"public".x$$;`,
                'isolated',
            ),
        ).toBe(
            `CREATE TYPE "isolated"."X" AS ENUM ('"public".x'); -- "public".x\nSELECT $$"public".x$$;`,
        );
    });
});
