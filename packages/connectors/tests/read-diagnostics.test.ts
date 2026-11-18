import { describe, expect, it } from 'vite-plus/test';
import { readDiagnostics } from '../src/reader/diagnostics.ts';
import { ConnectorError, type ReadDiagnostic } from '../src/types.ts';

describe('bounded internal Reader diagnostics', () => {
    it('keeps fixed fields only and bounds noisy sources', () => {
        const events: ReadDiagnostic[] = [];
        const diagnostics = readDiagnostics((event) => events.push(event), 15000);
        for (let i = 0; i < 100; i++)
            diagnostics.relay({
                phase: 'dns',
                state: 'end',
                elapsedMs: 2,
                remainingMs: 100,
                durationMs: 1,
                body: 'private',
            } as ReadDiagnostic);
        expect(events).toHaveLength(64);
        expect(Object.keys(events[0]).sort()).toEqual([
            'durationMs',
            'elapsedMs',
            'phase',
            'remainingMs',
            'state',
        ]);
    });
    it('preserves typed failures and ignores observer failures', async () => {
        const error = new ConnectorError('timeout', 'private detail', true);
        const events: ReadDiagnostic[] = [];
        const diagnostics = readDiagnostics((event) => {
            events.push(event);
            throw new Error('observer');
        }, 15000);
        await expect(
            diagnostics.stage('http', async () => {
                throw error;
            }),
        ).rejects.toBe(error);
        expect(events[1]).toMatchObject({ phase: 'http', state: 'error', code: 'timeout' });
        expect(JSON.stringify(events)).not.toContain('private detail');
    });
});
