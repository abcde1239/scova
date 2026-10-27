import { describe, expect, it } from 'vite-plus/test';
import {
    backupPath,
    databaseSettings,
    parseOperation,
    schemaName,
} from '../src/utils/operations.ts';
import { operationConfig } from '../src/app/operations.ts';

describe('offline operations boundaries', () => {
    it('requires explicit apply and accepts only command-specific arguments', () => {
        expect(parseOperation(['retention']).apply).toBe(false);
        expect(parseOperation(['restore', '--name=copy.dump', '--apply']).apply).toBe(true);
        for (const args of [
            ['retention', '--apply=false'],
            ['migrate', '--apply'],
            ['restore'],
            ['restore', '--name=../copy.dump'],
            ['ready', '--role=no'],
            ['delete-account', '--user-id=all'],
            ['retention', '--apply', '--apply'],
        ])
            expect(() => parseOperation(args)).toThrow();
    });
    it('rejects path traversal, schema injection and unsafe database schemes', () => {
        for (const name of ['../x.dump', '/x.dump', 'copy.dump/../x', 'x.sql', 'x.dump\n'])
            expect(() => backupPath('/backups', name)).toThrow();
        expect(backupPath('/backups', 'copy-01.dump')).toMatch(/copy-01.dump$/);
        for (const name of ['public;DROP', 'a-b', 'Upper', '', 'x'.repeat(64)])
            expect(() => schemaName(name)).toThrow();
        expect(() => databaseSettings('https://secret@example.test/db')).toThrow();
    });
    it('keeps postgres credentials out of arguments and preserves scoped schema', () => {
        const settings = databaseSettings(
            'postgresql://name:pass%40word@db:5432/scova?schema=private_test',
        );
        expect(settings.businessSchema).toBe('private_test');
        expect(settings.connectionString).not.toContain('schema=');
        expect(settings.pgEnv.PGPASSWORD).toBe('pass@word');
        expect(operationConfig({ DATABASE_URL: 'postgresql://db/scova' }).offline).toBe(false);
    });
});
