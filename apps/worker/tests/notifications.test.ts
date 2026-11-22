import { describe, expect, it } from 'vite-plus/test';
import { terminalNotificationKind } from '../../server/src/utils/execution/notifications.ts';

describe('terminal notification preferences', () => {
    for (const mode of ['summary', 'important_change', 'off'] as const)
        for (const runIssues of [true, false]) {
            const preference = { mode, runIssues };
            it(`${mode}/${runIssues} keeps delivery, changes and issues separate`, () => {
                for (const outcome of ['baseline', 'new_findings', 'no_important_change'])
                    expect(
                        terminalNotificationKind(preference, { status: 'succeeded', outcome }),
                    ).toBe(mode === 'summary' ? 'summary' : null);
                expect(
                    terminalNotificationKind(preference, {
                        status: 'succeeded',
                        outcome: 'important_change',
                    }),
                ).toBe(mode === 'off' ? null : mode);
                for (const status of ['partial', 'failed'] as const)
                    expect(
                        terminalNotificationKind(preference, {
                            status,
                            outcome: 'important_change',
                        }),
                    ).toBe(runIssues ? 'run_issue' : null);
                expect(terminalNotificationKind(preference, { status: 'canceled' })).toBeNull();
            });
        }
    it('does not borrow account defaults when the fixed preference is corrupt', () => {
        for (const value of [
            undefined,
            null,
            {},
            { mode: 'summary' },
            { mode: 'summary', runIssues: true, userId: 'injected' },
        ])
            expect(terminalNotificationKind(value, { status: 'failed' })).toBeNull();
    });
});
