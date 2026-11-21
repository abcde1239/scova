import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Report, Evidence } from '../../packages/models/src/report/schema.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T02:00:00Z';
const path = `/reports/${id(1)}`;
function evidence(n: number, old: boolean): Evidence {
    return {
        id: id(n),
        sourceId: id(20),
        snapshotId: id(100 + n),
        title: old ? '上期招生说明' : '本期招生说明',
        url: `https://example.test/${old ? 'old' : 'new'}`,
        quote: old ? '截止日期为11月1日，申请费为100元。' : '截止日期为12月1日，申请费为150元。',
        location: '已保存正文第2段',
        observedAt: instant,
        snapshot: {
            originalUrl: `https://example.test/${old ? 'old' : 'new'}`,
            fetchedUrl: 'https://example.test/admissions',
            canonicalUrl: 'https://example.test/admissions',
            contentHash: (old ? 'a' : 'b').repeat(64),
            extractorVersion: 'reader-v1',
            publishedAt: null,
            truncated: false,
            selector: { type: 'text_offset', start: 0, end: 20, extractorVersion: 'reader-v1' },
        },
    };
}
function fixture(): Report {
    return {
        id: id(1),
        runId: id(2),
        taskId: id(3),
        taskVersionId: id(4),
        baselineRunId: id(5),
        schemaVersion: 1,
        title: '招生截止日期与费用变化',
        summary: '截止日期与费用已有新公告，保留双方逐字引用。',
        format: 'brief',
        mode: 'demo',
        outcome: 'important_change',
        coverage: {
            completeness: 'complete',
            searchedQueries: ['招生公告'],
            gaps: [],
            exhausted: [],
        },
        limitations: [],
        claims: [
            {
                id: id(6),
                kind: 'fact',
                text: '本次申请截止日期为12月1日。',
                confidenceLabel: '来自原文',
                evidenceIds: [id(11)],
            },
        ],
        evidence: [evidence(10, true), evidence(11, false)],
        changes: [
            {
                id: id(30),
                sourceId: id(20),
                kind: 'changed',
                factKey: '招生申请截止日期',
                oldValue: '11月1日',
                newValue: '12月1日',
                oldEvidenceIds: [id(10)],
                newEvidenceIds: [id(11)],
                important: true,
                reason: '同一来源的申请截止日期发生变化。',
            },
            {
                id: id(31),
                sourceId: id(20),
                kind: 'changed',
                factKey: '申请费用',
                oldValue: '100元',
                newValue: '150元',
                oldEvidenceIds: [id(10)],
                newEvidenceIds: [id(11)],
                important: true,
                reason: '申请费用发生变化，请查阅双方原文。',
            },
        ],
        publishedAt: instant,
    };
}
type Kind = Report['changes'][number]['kind'];
function change(kind: Kind, n = 30): Report['changes'][number] {
    return {
        ...fixture().changes[0]!,
        id: id(n),
        kind,
        oldValue: kind === 'new' || kind === 'baseline' ? null : '11月1日',
        oldEvidenceIds: kind === 'new' || kind === 'baseline' ? [] : [id(10)],
        important: kind === 'changed',
    };
}
// These HTTP samples do not verify hidden ownership/manifest/run associations; the real API does.
async function samples(context: BrowserContext) {
    const state = { report: fixture(), failure: null as number | 'protocol' | 'missing' | null };
    const calls: { method: string; path: string }[] = [];
    await context.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/me')
            return route.fulfill({
                json: {
                    user: {
                        id: id(900),
                        email: 'changes@example.test',
                        createdAt: instant,
                        preferences: {
                            defaultTimezone: 'UTC',
                            notificationPreference: { mode: 'summary', runIssues: true },
                        },
                    },
                    csrfToken: 'sample-csrf',
                },
            });
        calls.push({ method: request.method(), path: url.pathname });
        if (
            url.pathname === `/api/v1/tasks/${state.report.taskId}/feedback` &&
            request.method() === 'GET'
        )
            return route.fulfill({ json: { items: [] } });
        if (url.pathname === '/api/v1/notes' && request.method() === 'GET')
            return route.fulfill({ json: { items: [], nextCursor: null } });
        if (
            url.pathname === `/api/v1/reports/${state.report.id}/conversation` &&
            request.method() === 'GET'
        )
            return route.fulfill({
                json: { reportId: state.report.id, turns: [], hasEarlier: false },
            });
        if (state.failure === 'protocol')
            return route.fulfill({ contentType: 'application/json', body: '{"broken"' });
        if (typeof state.failure === 'number')
            return route.fulfill({
                status: state.failure,
                json: {
                    code: state.failure === 409 ? 'INVALID_REPORT_EVIDENCE' : 'LOCAL_FAILURE',
                    message: 'local sample',
                    requestId: 'sample',
                },
            });
        const report = structuredClone(state.report);
        if (state.failure === 'missing')
            report.evidence = report.evidence.filter((entry) => entry.id !== id(10));
        return route.fulfill({ json: report });
    });
    return { state, calls };
}

const panel = (page: Page) => page.locator('.report-changes');
async function openReport(page: Page) {
    await page.goto(path);
    if ((page.viewportSize()?.width ?? 1440) < 1152)
        await page.getByRole('button', { name: '成果', exact: true }).click();
    await expect(page.locator('.artifact-document')).toBeVisible();
}
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
}
for (const width of [320, 768, 1440])
    for (const colorScheme of ['light', 'dark'] as const) {
        test(`single changes / citations / text resize ${width} ${colorScheme}`, async ({
            page,
        }, info) => {
            const { state } = await samples(page.context());
            state.report.baseline = { runId: id(5), reportId: id(50), publishedAt: instant };
            await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
            await page.setViewportSize({ width, height: 1000 });
            await openReport(page);
            await expect(panel(page)).toHaveCount(1);
            await expect(panel(page).getByRole('heading', { name: '2 项重要变化' })).toBeVisible();
            await expect(panel(page)).not.toContainText(id(5));
            await expect(panel(page).getByRole('link', { name: /对比.*的报告/ })).toHaveAttribute(
                'href',
                `/reports/${id(50)}`,
            );
            await expect(page.locator('.change-provenance, .comparison-table')).toHaveCount(0);
            for (const change of state.report.changes) {
                const record = panel(page).locator(`[data-change-id="${change.id}"]`);
                await expect(record).toHaveCount(1);
                await expect(record.locator('.old-value')).toHaveText(change.oldValue!);
                await expect(record.getByLabel('变为')).toHaveText('→');
                await expect(record.locator('.new-value')).toHaveText(change.newValue!);
                const citation = record.getByRole('link', { name: /（上次）/ });
                await citation.focus();
                await citation.press('Enter');
                await expect(page.locator((await citation.getAttribute('href'))!)).toBeFocused();
            }
            for (const size of ['100%', '200%']) {
                await page.evaluate(
                    (value) => (document.documentElement.style.fontSize = value),
                    size,
                );
                await noOverflow(page);
            }
            await info.attach('changes-200', {
                body: await page.screenshot({ fullPage: true }),
                contentType: 'image/png',
            });
        });
    }
for (const format of ['brief', 'list', 'comparison', 'research_report'] as const) {
    test(`one status across output form ${format}`, async ({ page }) => {
        const { state } = await samples(page.context());
        state.report.format = format;
        state.report.changes = [
            change('changed', 30),
            change('new', 31),
            change('baseline', 32),
            change('duplicate', 33),
            change('non_material', 34),
            change('duplicate_candidate', 35),
        ];
        await openReport(page);
        await expect(panel(page)).toHaveCount(1);
        await expect(panel(page).locator('.change-record:visible')).toHaveCount(2);
        const more = panel(page).getByText('其他 3 项', { exact: true });
        await more.focus();
        await more.press('Enter');
        await expect(panel(page).locator('.change-record:visible')).toHaveCount(5);
        await expect(panel(page).locator(`[data-change-id="${id(32)}"]`)).toHaveCount(0);
        await expect(page.locator('.comparison-table,.change-provenance')).toHaveCount(0);
    });
}
for (const stateName of ['eligible', 'model-only', 'date', 'none', 'uncertain'] as const) {
    test(`baseline status ${stateName}`, async ({ page }) => {
        const { state } = await samples(page.context());
        state.report.changes = [];
        state.report.outcome = 'inconclusive';
        let expected = '变化未定';
        if (['eligible', 'model-only', 'date'].includes(stateName)) {
            state.report.baselineRunId = null;
            state.report.coverage.baseline = {
                version: 1,
                eligible: stateName === 'eligible',
                reason:
                    stateName === 'eligible'
                        ? 'eligible'
                        : stateName === 'date'
                          ? 'date_unconfirmed'
                          : 'external_incomplete',
                modelOnlyFields: stateName === 'model-only' ? 5 : 0,
            };
            expected = stateName === 'eligible' ? '已设为比较起点' : '未设为比较起点';
        }
        if (stateName === 'none') {
            state.report.outcome = 'no_important_change';
            expected = '无重要变化';
        }
        await openReport(page);
        await expect(
            panel(page).getByRole('heading', { name: expected, exact: true }),
        ).toBeVisible();
        await expect(panel(page).locator('.change-record')).toHaveCount(0);
        if (stateName === 'model-only') {
            await expect(panel(page)).toContainText('5 个字段仅有模型回答');
            await panel(page).getByRole('link', { name: '查看缺口' }).press('Enter');
            await expect(page.locator('.coverage details')).toHaveAttribute('open', '');
        }
    });
}
for (const handling of ['separate', 'discard'] as const) {
    test(`collection date counts and precision ${handling}`, async ({ page }) => {
        const { state } = await samples(page.context());
        const report = state.report;
        report.format = 'list';
        report.changes = [];
        report.evidence = [evidence(11, false)];
        report.evidence[0]!.url = 'https://example.test/requested?utm_source=test';
        report.coverage.dateScreening = {
            window: { start: '2026-10-25T00:00:00Z', end: instant },
            accepted: 1,
            unconfirmed: 1,
            outside: 1,
            unconfirmedHandling: handling,
            entries: [
                {
                    pageId: 'read-1',
                    url: 'https://example.test/admissions',
                    title: '本次公告',
                    publishedAt: null,
                    dateValue: '2026-10-30',
                    dateKind: 'modified',
                    dateSource: 'dateModified',
                    status: 'accepted',
                },
                {
                    pageId: 'read-2',
                    url: 'https://example.test/unknown',
                    title: '日期不详线索',
                    publishedAt: null,
                    dateSource: null,
                    status: 'unconfirmed',
                },
                {
                    pageId: 'read-3',
                    url: 'https://example.test/outside',
                    title: '过期来源',
                    publishedAt: '2025-10-01T00:00:00Z',
                    dateSource: 'datePublished',
                    status: 'outside',
                },
            ],
        };
        await page.setViewportSize({ width: 320, height: 1000 });
        await openReport(page);
        await expect(page.getByLabel('采集日期筛选')).toContainText(
            '收录 1 页 · 日期未确认 1 页 · 窗口外剔除 1 页',
        );
        const table = page.getByRole('table', { name: '采集值、发布日期及直接出处' });
        await expect(table).toContainText('2026-10-30');
        await expect(table).toContainText('页面更新时间');
        await expect(table).not.toContainText('过期来源');
        await expect(table).not.toContainText('日期不详线索');
        const citation = table.getByRole('link', { name: '来源 1', exact: true });
        await citation.focus();
        await citation.press('Enter');
        const evidenceTarget = page.locator((await citation.getAttribute('href'))!);
        await expect(evidenceTarget).toBeFocused();
        await expect(evidenceTarget).toContainText(report.evidence[0]!.quote);
        const unknown = page.getByText('日期未确认的来源 · 不计入采集结果', { exact: true });
        if (handling === 'separate') {
            await unknown.press('Enter');
            await expect(page.getByRole('link', { name: /日期不详线索/ })).toBeVisible();
        } else await expect(unknown).toHaveCount(0);
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await noOverflow(page);
    });
}
