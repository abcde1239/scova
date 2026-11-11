import { expect, test } from './support/environment.ts';
import {
    assertAtomicDelivery,
    assertChangeCitations,
    attachProvenance,
    createTaskThroughUI,
    executeThroughUI,
    openReport,
} from './support/two-rounds.ts';

test('研究A/B/C：原文、次级来源、不同观点、作者修订与正文失败限制', async ({
    environment,
    browser,
}, info) => {
    console.log(`Browser: Chromium ${browser.version()}`);
    const owner = await environment.owner();
    const config = environment.config('research');
    config.title = '研究观点与作者修订';
    config.goal =
        'Track original research, secondary reporting, contrasting findings and author revisions';
    // This journey checks all evidence types, including background and unresolved
    // material; the brief's separate length policy may deliberately trim them.
    config.outputFormat = 'research_report';
    const task = await createTaskThroughUI(owner, config);
    const first = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'research',
        phase: 'A',
    });
    const second = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'research',
        phase: 'B',
    });
    expect(first.report.outcome).toBe('baseline');
    expect(second.report.baselineRunId).toBe(first.run.id);
    const secondary = second.report.changes.filter(
        (entry) => entry.kind === 'duplicate_candidate' && entry.reason.includes('次级来源'),
    );
    expect(secondary).toHaveLength(1);
    expect(secondary[0]!.reason).toContain('不增加独立新研究');
    const revision = second.report.changes.filter(
        (entry) => entry.kind === 'changed' && entry.reason.includes('修订'),
    );
    expect(revision).toHaveLength(1);
    expect(revision[0]).toMatchObject({
        oldValue: '20 participants',
        newValue: '40 participants',
        important: true,
    });
    expect(
        second.report.changes.some(
            (entry) => entry.kind === 'new' && entry.reason.includes('不同观点'),
        ),
    ).toBe(true);
    expect(
        second.report.claims.some(
            (entry) =>
                entry.kind === 'inference' && entry.text.includes('不据此断定旧研究已被推翻'),
        ),
    ).toBe(true);
    await openReport(owner.page, second.report);
    await assertChangeCitations(
        owner.page,
        second.report,
        (entry) => entry.reason.includes('修订') || entry.reason.includes('不同观点'),
    );
    // Current reports group answers by question; supporting and disputed claims
    // remain readable in the reference disclosure with their original confidence.
    await owner.page.locator('.references > summary').click();
    for (const kind of ['fact', 'inference', 'conflict', 'insufficient']) {
        const claims = second.report.claims.filter((claim) => claim.kind === kind);
        expect(claims.length).toBeGreaterThan(0);
        for (const claim of claims) {
            const row = owner.page.locator(`#claim-${claim.id}`);
            await expect(row).toHaveCount(1);
            await expect(row).toBeVisible();
            await expect(row.locator('.claim-text')).toHaveText(claim.text);
            await expect(row.locator('.confidence')).toContainText(claim.confidenceLabel);
        }
    }
    await expect(owner.page.locator('.answers')).toContainText('不据此断定旧研究已被推翻');
    const conflict = second.report.claims.find((entry) => entry.kind === 'conflict')!;
    expect(conflict.evidenceIds.length).toBeGreaterThanOrEqual(2);
    const conflictRow = owner.page.locator(`#claim-${conflict.id}`);
    await expect(conflictRow.locator('.citation')).toHaveCount(conflict.evidenceIds.length);
    for (const reference of await conflictRow.locator('.citation').all()) {
        await reference.press('Enter');
        const citation = owner.page.locator((await reference.getAttribute('href'))!);
        await expect(citation.locator('blockquote')).toBeVisible();
    }
    await expect(owner.page.locator('.report-changes')).toContainText('不增加独立新研究');
    const third = await executeThroughUI(environment, owner, task.task.id, {
        mode: 'live',
        scenario: 'research',
        phase: 'C',
    });
    expect(third.report.coverage.completeness).toBe('partial');
    expect(third.report.outcome).not.toBe('no_important_change');
    await openReport(owner.page, third.report);
    await expect(owner.page.getByRole('note', { name: '查阅范围说明' })).toBeVisible();
    await owner.page.locator('.coverage summary').press('Enter');
    for (const gap of third.report.coverage.gaps)
        await expect(owner.page.locator('.coverage')).toContainText(gap);
    await assertAtomicDelivery(environment, owner, task.task.id, [
        first.report,
        second.report,
        third.report,
    ]);
    await attachProvenance(info, environment, [first, second, third]);
});
