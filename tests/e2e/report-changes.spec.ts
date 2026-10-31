import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { Report, Evidence } from '../../packages/models/src/reports.ts';

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
const kinds = [
    ['baseline', '基线记录'],
    ['new', '新增资料'],
    ['changed', '实质变化'],
    ['duplicate', '重复资料'],
    ['duplicate_candidate', '疑似转载'],
    ['non_material', '非实质变化'],
    ['uncertain', '待核验'],
] as const;
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
const panel = (page: Page) => page.getByRole('region', { name: '变化与基线', exact: true });
const record = (page: Page, n = 30) =>
    panel(page).locator(`article[aria-labelledby="change-${id(n)}"]`);
async function screenshot(page: Page, info: TestInfo, name: string, fullPage = false) {
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
    await info.attach(name, {
        body: await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage }),
        contentType: 'image/png',
    });
}
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
    );
    for (const control of await panel(page).locator('summary, a').all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box!.height).toBeGreaterThanOrEqual(44);
    }
}
for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`招生变化${width}：双方引用键盘展开、普通与200%文字重排`, async ({
        page,
        baseURL,
    }, info) => {
        const { calls } = await samples(page.context());
        const external: string[] = [];
        const errors: string[] = [];
        page.on('request', (request) => {
            if (new URL(request.url()).origin !== new URL(baseURL!).origin)
                external.push(request.url());
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(path);
        await expect(panel(page)).toBeVisible();
        await expect(
            panel(page).getByRole('heading', { name: '报告记录了重要变化', exact: true }),
        ).toBeVisible();
        await expect(panel(page).locator('.comparison-context dd').first()).toHaveText('演示数据');
        await expect(panel(page).locator('.comparison-context dd').last()).toHaveText(id(5));
        await expect(page.locator('.metadata')).toContainText(id(4));
        for (const [n, oldValue, newValue] of [
            [30, '11月1日', '12月1日'],
            [31, '100元', '150元'],
        ] as const) {
            await expect(record(page, n).locator('.old-side .change-value')).toHaveText(oldValue);
            await expect(record(page, n).locator('.new-side .change-value')).toHaveText(newValue);
            await expect(record(page, n)).toContainText('重要性标记：重要');
            for (const side of ['old', 'new']) {
                const section = record(page, n).locator(`.${side}-side`);
                const summary = section.locator('summary');
                await summary.focus();
                await summary.press('Enter');
                await expect(section.locator('details')).toHaveAttribute('open', '');
                await expect(section.locator('blockquote')).toHaveText(
                    side === 'old'
                        ? '截止日期为11月1日，申请费为100元。'
                        : '截止日期为12月1日，申请费为150元。',
                );
                await expect(section.getByRole('link')).toHaveAttribute(
                    'href',
                    `https://example.test/${side}`,
                );
                await expect(section.getByRole('link')).toHaveAttribute('target', '_blank');
                await expect(section.getByRole('link')).toHaveAttribute(
                    'rel',
                    'noopener noreferrer',
                );
            }
        }
        expect(
            await record(page)
                .locator('.change-value')
                .first()
                .evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Noto Serif SC');
        expect(
            await record(page)
                .locator('summary')
                .first()
                .evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Inter');
        for (const enlarged of [false, true]) {
            if (enlarged)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            await noOverflow(page);
            const old = (await record(page).locator('.old-side').boundingBox())!;
            const current = (await record(page).locator('.new-side').boundingBox())!;
            if (width <= 390) expect(current.y).toBeGreaterThan(old.y + old.height);
            if (!enlarged && width >= 1024)
                expect(Math.abs(current.y - old.y)).toBeLessThanOrEqual(1);
            await panel(page).scrollIntoViewIfNeeded();
            await screenshot(
                page,
                info,
                enlarged ? 'comparison-text-200-viewport' : 'comparison-viewport',
            );
            await screenshot(
                page,
                info,
                enlarged ? 'comparison-text-200' : 'comparison-normal',
                true,
            );
        }
        expect(calls).toEqual([{ method: 'GET', path: `/api/v1/reports/${id(1)}` }]);
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
    });
}
test('七分类保持原因与important，必要分类文字和非零计数逐组可读', async ({ page }, info) => {
    const { state } = await samples(page.context());
    state.report.changes = kinds.map(([kind], index) => ({
        ...change(kind, 40 + index),
        reason: `服务端原始原因-${kind}`,
    }));
    state.report.outcome = 'inconclusive';
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(path);
    await expect(panel(page).locator('.change-group')).toHaveCount(7);
    for (const [index, [kind, title]] of kinds.entries()) {
        const group = panel(page).getByRole('region', { name: `${title} · 1 项`, exact: true });
        await expect(group).toContainText(`服务端原始原因-${kind}`);
        await expect(record(page, 40 + index)).toContainText(
            kind === 'changed' ? '重要性标记：重要' : '重要性标记：未标记为重要',
        );
    }
    await expect(
        panel(page).getByRole('heading', { name: '变化结论仍不确定', exact: true }),
    ).toBeVisible();
    await panel(page).scrollIntoViewIfNeeded();
    await screenshot(page, info, 'seven-kinds-viewport');
});
for (const scenario of [
    'complete-zero',
    'partial-null-baseline',
    'inconclusive',
    'uncertain',
    'missing-old',
    'important-conflict',
    'baseline',
    'new-findings',
] as const) {
    test(`变化摘要${scenario}：保留服务端分类，保守表达结论`, async ({ page }, info) => {
        const { state } = await samples(page.context());
        state.report.outcome = 'no_important_change';
        state.report.changes = [change('duplicate')];
        let title = '变化结论仍不确定';
        if (scenario === 'complete-zero') {
            state.report.changes = [];
            title = '本次范围内未发现重要变化';
        }
        if (scenario === 'partial-null-baseline') {
            state.report.baselineRunId = null;
            state.report.outcome = 'inconclusive';
            state.report.coverage.completeness = 'partial';
            state.report.coverage.gaps = ['旧范围未完成比较'];
            state.report.changes = [change('baseline')];
        }
        if (scenario === 'inconclusive') state.report.outcome = 'inconclusive';
        if (scenario === 'uncertain') state.report.changes = [change('uncertain')];
        if (scenario === 'missing-old')
            state.report.changes = [{ ...change('non_material'), oldEvidenceIds: [] }];
        if (scenario === 'important-conflict') {
            state.report.changes = [change('changed')];
            title = '变化结论仍需核对';
        }
        if (scenario === 'baseline') {
            state.report.outcome = 'baseline';
            state.report.baselineRunId = null;
            state.report.changes = [change('baseline')];
            title = '本次建立比较基线';
        }
        if (scenario === 'new-findings') {
            state.report.outcome = 'new_findings';
            state.report.changes = [change('new')];
            title = '报告记录了新增发现';
        }
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.goto(path);
        await expect(panel(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
        if (scenario !== 'complete-zero')
            await expect(
                panel(page).getByRole('heading', { name: '本次范围内未发现重要变化', exact: true }),
            ).toHaveCount(0);
        if (scenario === 'complete-zero')
            await expect(panel(page)).toContainText('本报告没有提供逐项变化记录');
        if (scenario === 'partial-null-baseline') {
            await expect(
                page.getByRole('note', { name: '部分交付警告', exact: true }),
            ).toBeVisible();
            await expect(panel(page)).toContainText('报告未提供关联的基线执行');
            await expect(
                panel(page).getByRole('heading', { name: '本次建立比较基线', exact: true }),
            ).toHaveCount(0);
        }
        if (scenario === 'missing-old')
            await expect(record(page)).toContainText('旧值缺少可核对引用');
        await panel(page).scrollIntoViewIfNeeded();
        await screenshot(page, info, `${scenario}-viewport`);
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await noOverflow(page);
        await panel(page).scrollIntoViewIfNeeded();
        await screenshot(page, info, `${scenario}-text-200-viewport`);
    });
}
test('null新值不产生删除撤回断言，长值与普通文本quote安全重排', async ({ page }, info) => {
    const { state } = await samples(page.context());
    state.report.outcome = 'inconclusive';
    state.report.changes = [
        {
            ...change('uncertain'),
            oldValue: '尚未核验的旧公告适用范围。'.repeat(20),
            newValue: null,
            newEvidenceIds: [],
        },
    ];
    state.report.evidence[0]!.quote = '<script>window.changeExecuted=true</script> 旧公告原文';
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto(path);
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await expect(record(page).locator('.new-side .change-value')).toHaveText('未提供新值');
    await expect(record(page).locator('.new-side')).toContainText('未提供本次观测引用');
    await expect(panel(page)).not.toContainText('资料已撤回。');
    await record(page).locator('.old-side summary').press('Enter');
    await expect(record(page).locator('.old-side blockquote')).toHaveText(
        state.report.evidence[0]!.quote,
    );
    expect(await page.evaluate(() => 'changeExecuted' in window)).toBe(false);
    await noOverflow(page);
    await record(page).locator('.new-side').scrollIntoViewIfNeeded();
    await screenshot(page, info, 'null-long-value-text-200-viewport');
});
for (const side of ['old', 'new']) {
    test(`样本API拒绝${side}侧409：缓存全报告隐藏且键盘重试恢复`, async ({ page }, info) => {
        const { state } = await samples(page.context());
        await page.clock.install();
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.goto(path);
        await expect(panel(page)).toBeVisible();
        await record(page).locator(`.${side}-side summary`).click();
        await page.getByRole('link', { name: '阅读外观', exact: true }).click();
        await expect(page).toHaveURL(/\/account\/appearance$/);
        state.failure = 409;
        await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 31000));
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        await expect(page.getByRole('status')).toContainText('报告证据校验未通过');
        await expect(page.locator('article.report-brief, .report-changes, blockquote')).toHaveCount(
            0,
        );
        await screenshot(page, info, `${side}-409-viewport`);
        state.failure = null;
        await page.getByRole('button', { name: '重试', exact: true }).press('Enter');
        await expect(panel(page)).toBeVisible();
        await expect(page.locator('#report-title')).toBeFocused();
    });
}
for (const status of [403, 404, 503, 'protocol', 'missing'] as const) {
    test(`变化读取${status}：失败不展示半份变化面板`, async ({ page }, info) => {
        const { state } = await samples(page.context());
        state.failure = status;
        await page.setViewportSize({ width: 320, height: 1000 });
        await page.goto(path);
        await expect(page.getByRole('status')).toContainText('加载失败');
        await expect(panel(page)).toHaveCount(0);
        await screenshot(page, info, `failure-${status}-viewport`);
        if (status !== 403 && status !== 404) {
            state.failure = null;
            await page.getByRole('button', { name: '重试', exact: true }).press('Enter');
            await expect(panel(page)).toBeVisible();
        }
    });
}
test('live模式与配置、基线标识仍按真实报告展示', async ({ page }) => {
    const { state, calls } = await samples(page.context());
    state.report.mode = 'live';
    await page.goto(path);
    await expect(page.locator('.report-header .mode')).toHaveText('真实查阅报告');
    await expect(panel(page).locator('.comparison-context dd').first()).toHaveText('真实查阅');
    await expect(panel(page).locator('.comparison-context dd').last()).toHaveText(id(5));
    await expect(page.locator('.metadata')).toContainText(id(4));
    expect(calls).toHaveLength(1);
});
