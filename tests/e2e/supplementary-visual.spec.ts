import { openReportTool } from './support/report-tools.ts';
import { expect, test } from './support/environment.ts';
import { deliveryCounts } from './support/two-rounds.ts';

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

// Production UI and real delivery. This is layout/interaction coverage, not a
// replacement for the full data-correctness journey or physical mobile devices.
async function layout(page: import('@playwright/test').Page, scale: number) {
    await page.evaluate((value) => {
        document.documentElement.style.fontSize = `${value}%`;
    }, scale);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
        true,
    );
}

test('补充入口六宽/文字放大、四主题浅暗与四报告形式（真实隔离服务）', async ({
    environment,
    browser,
}, info) => {
    test.setTimeout(1_200_000);
    const owner = await environment.owner();
    const page = owner.page;
    const demoTask = await environment.task(owner);
    const demo = await environment.execute(owner, demoTask.id, 'demo');
    const prepared = await environment.prepareDisplay(owner, 'english');
    const report = prepared.rounds[1].report;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/reports/${report.id}`);
    await openReportTool(page, 'bookmarks');
    await page
        .getByLabel('选择收藏来源', { exact: true })
        .selectOption(report.evidence[0]!.sourceId);
    await page.getByRole('button', { name: '收藏来源', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
    await openReportTool(page, 'notes');
    await page.getByRole('button', { name: '新建笔记', exact: true }).press('Enter');
    await page
        .getByLabel('本地笔记正文', { exact: true })
        .fill('六宽联合验收笔记：中文、原文与费用变化。');
    await page.getByRole('button', { name: '创建笔记', exact: true }).press('Enter');
    await expect(page.locator('.note-body').filter({ hasText: '六宽联合验收笔记' })).toBeVisible();
    await page.getByRole('button', { name: '取消编辑', exact: true }).press('Enter');
    const deliveryBefore = await deliveryCounts(environment, owner, prepared.task.id);
    await page.getByLabel('问题', { exact: true }).fill('这些证据还缺少哪些独立核验？');
    await page.getByRole('button', { name: '提问', exact: true }).press('Enter');
    await expect(
        page.getByRole('heading', { name: '未获得可核验回答', exact: true }),
    ).toBeVisible();
    const questionUrl = page.url();
    const questionId = new URL(questionUrl).searchParams.get('questionId');
    expect(questionId).toBeTruthy();
    expect(await deliveryCounts(environment, owner, prepared.task.id)).toEqual(deliveryBefore);
    const records: unknown[] = [];
    const writes: string[] = [];
    page.on('request', (request) => {
        if (!['GET', 'HEAD'].includes(request.method()))
            writes.push(new URL(request.url()).pathname);
    });
    for (const [accent, label] of [
        ['blue', '蓝色'],
        ['pine', '松绿'],
        ['iris', '鸢尾'],
        ['amber', '琥珀'],
    ] as const) {
        for (const [scheme, schemeLabel] of [
            ['light', '浅色'],
            ['dark', '深色'],
        ] as const) {
            await page.goto('/account/appearance');
            await page
                .getByRole('group', { name: '主题色', exact: true })
                .getByRole('radio', { name: label, exact: true })
                .check();
            await page
                .getByRole('group', { name: '明暗', exact: true })
                .getByRole('radio', { name: schemeLabel, exact: true })
                .check();
            for (const width of [1440, 1024, 768, 390, 360, 320]) {
                await page.setViewportSize({ width, height: 1000 });
                for (const scale of [100, 200]) {
                    for (const saved of [report, demo.report]) {
                        await page.goto(
                            `/reports/${saved.id}${saved.id === report.id ? `?questionId=${questionId}` : ''}`,
                        );
                        const selector = page.getByLabel('报告形式', { exact: true });
                        await expect(selector).toBeVisible();
                        await expect(page.locator('.scova-theme')).toHaveClass(
                            scheme === 'dark' ? /scova-theme--dark/ : /^scova-theme$/,
                        );
                        await layout(page, scale);
                        for (const format of ['brief', 'list', 'comparison', 'research_report']) {
                            const before = writes.length;
                            await selector.selectOption(format);
                            const frame = page.locator('.report-frame');
                            await expect(frame).toBeVisible();
                            expect(
                                await frame
                                    .locator('.evidence-entry')
                                    .evaluateAll((elements) =>
                                        elements.map((element) => element.id),
                                    ),
                            ).toEqual(saved.evidence.map((evidence) => `evidence-${evidence.id}`));
                            if (saved.coverage.completeness === 'partial')
                                await expect(
                                    page.getByRole('note', { name: '部分交付警告' }),
                                ).toBeVisible();
                            await layout(page, scale);
                            const evidence = frame.locator('.evidence-entry').first();
                            const quote = evidence.locator('details.evidence summary');
                            await quote.press('Enter');
                            await expect(evidence.locator('blockquote')).toBeVisible();
                            await quote.press('Enter');
                            if (format === 'comparison') {
                                for (const change of saved.changes) {
                                    const row = page.locator(`#comparison-change-${change.id}`);
                                    for (const side of ['old', 'new'] as const) {
                                        const ids = change[`${side}EvidenceIds`];
                                        await expect(
                                            row.locator(`.${side}-side details.evidence`),
                                        ).toHaveCount(ids.length);
                                        for (const id of ids) {
                                            const citation = row.locator(
                                                `#comparison-${change.id}-${side}-${id}`,
                                            );
                                            await citation.locator('summary').press('Enter');
                                            await expect(citation.locator('blockquote')).toHaveText(
                                                saved.evidence.find((item) => item.id === id)!
                                                    .quote,
                                            );
                                        }
                                    }
                                }
                                if (saved.changes.length && width === 320 && scale === 200) {
                                    const scroll = frame.locator('.comparison-scroll');
                                    await expect(scroll).toHaveAttribute('tabindex', '0');
                                    await scroll.evaluate((element) => {
                                        element.scrollLeft = 0;
                                    });
                                    await scroll.focus();
                                    await page.keyboard.press('ArrowRight');
                                    await expect
                                        .poll(() =>
                                            scroll.evaluate((element) => element.scrollLeft),
                                        )
                                        .toBeGreaterThan(0);
                                    await scroll.evaluate((element) => {
                                        element.scrollLeft = 0;
                                    });
                                    await layout(page, scale);
                                }
                            }
                            if (
                                accent === 'blue' &&
                                ((width === 1440 && scale === 100) ||
                                    (width === 320 && scale === 200))
                            )
                                await info.attach(
                                    `${scheme}-${width}-${scale}-${saved.id === report.id ? 'live' : 'demo'}-${format}`,
                                    {
                                        body: await page.screenshot({ fullPage: true }),
                                        contentType: 'image/png',
                                    },
                                );
                            await selector.focus();
                            await page.keyboard.press('Tab');
                            await expect(
                                page.getByRole('link', { name: '正文', exact: true }),
                            ).toBeFocused();
                            expect(writes.length).toBe(before);
                            records.push({
                                accent,
                                scheme,
                                width,
                                scale,
                                reportId: saved.id,
                                format,
                            });
                        }
                    }
                    // Collection/search/snapshot entry points remain real authenticated pages.
                    for (const path of [
                        '/library',
                        '/library/search',
                        `/library/sources/${report.evidence[0]!.sourceId}/snapshots/${report.evidence[0]!.snapshotId}`,
                        '/tasks',
                        `/tasks/${prepared.task.id}`,
                        `/tasks/reports?taskId=${prepared.task.id}`,
                    ]) {
                        await page.goto(path);
                        await expect(page.getByRole('main')).toBeVisible();
                        if (path === '/library') {
                            await expect(page.locator('.bookmark-entry')).toHaveCount(1);
                            await page
                                .getByRole('button', { name: '笔记', exact: true })
                                .press('Enter');
                            const note = page
                                .locator('.note-entry')
                                .filter({ hasText: '六宽联合验收笔记' });
                            await expect(note).toBeVisible();
                            await note
                                .getByRole('button', { name: '编辑笔记', exact: true })
                                .press('Enter');
                            await expect(
                                page.getByLabel('本地笔记正文', { exact: true }),
                            ).toHaveValue(/六宽联合验收笔记/);
                            await layout(page, scale);
                            await page
                                .getByRole('button', { name: '取消编辑', exact: true })
                                .press('Enter');
                        } else if (path === '/library/search') {
                            await page
                                .getByLabel('搜索已保存资料', { exact: true })
                                .fill('六宽联合验收笔记');
                            await page
                                .getByLabel(/^资料类型/)
                                .selectOption('note', { timeout: 10_000 });
                            await page
                                .getByRole('button', { name: '搜索已存资料', exact: true })
                                .press('Enter');
                            await expect(page.locator('.search-result')).toHaveCount(1);
                            await expect(page.locator('.search-result')).toContainText(
                                '六宽联合验收笔记',
                            );
                        } else if (path.includes('/snapshots/')) {
                            await expect(page.locator('.snapshot-detail')).toBeVisible();
                            await page
                                .getByText('查看保留期内正文', { exact: true })
                                .press('Enter');
                            await expect(page.locator('.snapshot-body')).toContainText(
                                report.evidence[0]!.quote,
                            );
                        } else if (path.startsWith('/tasks/reports')) {
                            await expect(page.locator('.report-history')).toContainText(
                                report.title,
                            );
                        } else if (path === '/tasks') {
                            const history = page.locator(
                                `a.task-history-link[href="/tasks/reports?taskId=${prepared.task.id}"]`,
                            );
                            await expect(history).toHaveText('报告历史');
                            await layout(page, scale);
                            await history.press('Enter');
                            await expect(page).toHaveURL(
                                (url) =>
                                    url.pathname === '/tasks/reports' &&
                                    url.searchParams.get('taskId') === prepared.task.id,
                            );
                            await expect(page.getByLabel(/^筛选任务/)).toHaveValue(
                                prepared.task.id,
                            );
                            await expect(page.locator('.report-history')).toContainText(
                                report.title,
                            );
                        } else {
                            await expect(page.locator('.task-summary')).toBeVisible();
                            await expect(page.locator('.run-history')).toContainText('执行历史');
                            await expect(
                                page.getByRole('link', { name: '编辑任务配置', exact: true }),
                            ).toBeVisible();
                        }
                        await layout(page, scale);
                        if (width === 320 && scale === 200 && accent === 'blue')
                            await info.attach(`${scheme}-${path.split('/')[1]}-${records.length}`, {
                                body: await page.screenshot({ fullPage: true }),
                                contentType: 'image/png',
                            });
                    }
                    await page.goto(questionUrl);
                    await layout(page, scale);
                    await openReportTool(page, 'feedback');
                    const feedback = page.locator('.feedback-actions');
                    await feedback
                        .getByLabel('选择反馈资料或结论', { exact: true })
                        .selectOption(`source:${report.evidence[0]!.sourceId}`);
                    const known = feedback.getByRole('button', { name: '已了解', exact: true });
                    await expect(known).toBeEnabled();
                    await known.press('Enter');
                    await expect(feedback.locator('.selected-target')).toContainText(
                        '当前反馈：已了解',
                    );
                    await layout(page, scale);
                    const undo = feedback.getByRole('button', {
                        name: '撤销所选反馈',
                        exact: true,
                    });
                    await expect(undo).toBeEnabled();
                    await undo.press('Enter');
                    await expect(feedback.locator('.selected-target')).toContainText(
                        '当前反馈：未设置',
                    );
                    const open = page.getByRole('button', {
                        name: '确认后建立独立后续执行',
                        exact: true,
                    });
                    await expect(open).toBeEnabled();
                    await open.press('Enter');
                    const dialog = page.getByRole('dialog', { name: '确认建立独立后续执行' });
                    await expect(dialog).toBeVisible();
                    await expect(
                        dialog.getByRole('button', { name: '确认并建立后续执行', exact: true }),
                    ).toBeEnabled();
                    await layout(page, scale);
                    const bounds = await dialog.evaluate((element) => {
                        const rect = element.getBoundingClientRect();
                        const footer = element.querySelector('footer')!.getBoundingClientRect();
                        return {
                            left: rect.left,
                            right: rect.right,
                            bottom: rect.bottom,
                            footerBottom: footer.bottom,
                            width: innerWidth,
                            height: innerHeight,
                            overflow: element.scrollWidth > element.clientWidth + 1,
                        };
                    });
                    expect(bounds.left).toBeGreaterThanOrEqual(-1);
                    expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
                    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
                    expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.height + 1);
                    expect(bounds.overflow).toBe(false);
                    if (accent === 'blue' && width === 320 && scale === 200)
                        await info.attach(`${scheme}-320-200-followup-dialog`, {
                            body: await page.screenshot(),
                            contentType: 'image/png',
                        });
                    const beforeCancel = writes.length;
                    await page.keyboard.press('Escape');
                    await expect(dialog).not.toBeVisible();
                    await expect(open).toBeFocused();
                    expect(writes.length).toBe(beforeCancel);
                }
            }
        }
    }
    expect(errors).toEqual([]);
    expect(writes.every((path) => path.includes('/feedback'))).toBe(true);
    expect(await deliveryCounts(environment, owner, prepared.task.id)).toEqual(deliveryBefore);
    await info.attach('supplementary-production-matrix', {
        body: JSON.stringify({
            browser: browser.version(),
            remoteResearch: false,
            provenance: 'executed-supplier-fixture-and-demo',
            screenReaderVerified: false,
            browserZoomVerified: false,
            realDeviceVerified: false,
            records,
        }),
        contentType: 'application/json',
    });
});
