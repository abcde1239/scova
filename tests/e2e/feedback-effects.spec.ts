import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import type {
    Feedback,
    FeedbackEffect,
    FeedbackInput,
} from '../../packages/models/src/feedback.ts';
import type { Report } from '../../packages/models/src/reports.ts';

// Controlled Report HTTP samples exercise the real production Web bundle, not Worker/DB policy.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-10-31T02:00:00Z';
const path = `/reports/${id(1)}`;
const nextPath = `/reports/${id(100)}`;
const labels: [FeedbackEffect['effect'], string][] = [
    ['expanded_query', '深入查询已执行'],
    ['promoted', '目标来源已优先采集'],
    ['excluded', '已排除新发现候选'],
    ['deprioritized', '未变结论已后移'],
    ['baseline_protected', '基线来源保留复读'],
    ['monitoring', '已读取目标来源'],
    ['not_applied_budget', '未执行：预算不足'],
    ['not_applied_unmatched', '未执行：未匹配'],
    ['not_applied_policy', '未执行：策略限制'],
];
function effect(extra: Partial<FeedbackEffect> = {}): FeedbackEffect {
    return {
        feedbackId: id(30),
        kind: 'deeper',
        targetType: 'source',
        targetId: id(10),
        effect: 'promoted',
        reason: '已优先采集目标来源正文；不代表所有条件都已查证。',
        ...extra,
    };
}
function fixture(): Report {
    return {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: id(5),
        schemaVersion: 1,
        title: '受控反馈作用报告：保留重要新事实与原始引用',
        summary: '重要新事实与未变内容分别保留，反馈说明不改变报告结论。',
        format: 'brief',
        mode: 'demo',
        outcome: 'important_change',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['公开申请政策'],
            gaps: ['明确受控展示样本，尚有查阅缺口'],
            exhausted: [],
        },
        limitations: ['仅代表保存来源，不是穷尽互联网研究'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '重要新事实：申请费调整为120元。',
                confidenceLabel: '新值来自保存原文',
                evidenceIds: [id(20)],
            },
            {
                id: id(11),
                kind: 'inference',
                text: '未变条件仍需结合适用范围理解。',
                confidenceLabel: '推断仍待核实',
                evidenceIds: [id(21)],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(10),
                snapshotId: id(22),
                title: '本报告资料的真实标题',
                url: 'https://example.test/source',
                quote: '申请费现为120元。',
                location: '第2段',
                observedAt: instant,
            },
            {
                id: id(21),
                sourceId: id(10),
                snapshotId: id(23),
                title: '同一资料的另一引用',
                url: 'https://example.test/source',
                quote: '申请费原为100元。',
                location: '第1段',
                observedAt: '2026-10-30T02:00:00Z',
            },
        ],
        changes: [
            {
                id: id(50),
                sourceId: id(10),
                kind: 'changed',
                factKey: '申请费',
                oldValue: '100元',
                newValue: '120元',
                oldEvidenceIds: [id(21)],
                newEvidenceIds: [id(20)],
                important: true,
                reason: '保存原文中的重要费用新值',
            },
            {
                id: id(51),
                sourceId: id(10),
                kind: 'new',
                factKey: '新增申请范围',
                oldValue: null,
                newValue: '新增批次',
                oldEvidenceIds: [],
                newEvidenceIds: [id(20)],
                important: true,
                reason: '原始分类仍为新增',
            },
        ],
        feedbackEffects: labels.map(([name], index) =>
            effect({
                effect: name,
                reason: `原始原因 ${index + 1}：${name}`,
                kind: index % 3 === 0 ? 'deeper' : index % 3 === 1 ? 'known' : 'irrelevant',
                ...(index === 0
                    ? {
                          query: '深入查询的完整原文',
                          url: 'https://example.test/details?q=original',
                      }
                    : {}),
            }),
        ),
        publishedAt: instant,
    };
}
function active(extra: Partial<Feedback> = {}): Feedback {
    return {
        id: id(30),
        taskId: id(2),
        sourceId: id(10),
        claimId: null,
        kind: 'known',
        active: true,
        updatedAt: instant,
        ...extra,
    };
}
type Fault = number | 'protocol' | 'invalid' | null;
async function samples(context: BrowserContext) {
    const state = {
        reports: {
            [path]: fixture(),
            [nextPath]: { ...fixture(), id: id(100), runId: id(101), feedbackEffects: [] },
        } as Record<string, Report>,
        current: [active()],
        owner: 900,
        failure: null as Fault,
        feedbackFailure: null as number | null,
        reportWait: undefined as Promise<void> | undefined,
        lateStatus: 200,
    };
    const calls: { method: string; path: string; body?: unknown }[] = [];
    await context.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const owner = state.owner;
        const account = () => ({
            user: {
                id: id(state.owner),
                email: 'effects@example.test',
                createdAt: instant,
                preferences: {
                    defaultTimezone: 'UTC',
                    notificationPreference: { mode: 'summary', runIssues: true },
                },
            },
            csrfToken: 'effects-test-only',
        });
        calls.push({
            method: request.method(),
            path: url.pathname,
            ...(request.method() === 'POST' ? { body: request.postDataJSON() } : {}),
        });
        const fail = (status: number) =>
            route.fulfill({
                status,
                json: {
                    code: status === 409 ? 'INVALID_REPORT_EVIDENCE' : 'SAMPLE_ERROR',
                    message: 'controlled sample',
                    requestId: 'sample',
                },
            });
        if (url.pathname === '/api/v1/me') return route.fulfill({ json: account() });
        if (url.pathname === '/api/v1/auth/logout') return route.fulfill({ status: 204 });
        if (url.pathname === '/api/v1/auth/login') {
            state.owner++;
            return route.fulfill({ json: account() });
        }
        if (url.pathname.startsWith('/api/v1/reports/')) {
            if (owner !== 900) return fail(404);
            const saved = structuredClone(state.reports[url.pathname.slice('/api/v1'.length)]);
            const fault = state.failure;
            const waited = state.reportWait;
            if (waited) {
                await waited;
                if (state.lateStatus !== 200) return fail(state.lateStatus);
            }
            if (fault === 'protocol')
                return route.fulfill({ contentType: 'application/json', body: '{broken' });
            if (fault === 'invalid')
                return route.fulfill({
                    json: { ...saved, feedbackEffects: [{ ...effect(), effect: 'invented' }] },
                });
            if (fault) return fail(fault);
            return route.fulfill({ json: saved });
        }
        if (url.pathname === `/api/v1/tasks/${id(2)}/feedback`) {
            if (state.feedbackFailure) return fail(state.feedbackFailure);
            return route.fulfill({
                json: { items: owner === 900 ? state.current.filter((entry) => entry.active) : [] },
            });
        }
        if (url.pathname === '/api/v1/feedback' && request.method() === 'POST') {
            const input = request.postDataJSON() as FeedbackInput;
            const previous = state.current.find((entry) =>
                input.sourceId
                    ? entry.sourceId === input.sourceId
                    : entry.claimId === input.claimId,
            );
            const result =
                previous ??
                active({
                    id: id(60),
                    sourceId: input.sourceId ?? null,
                    claimId: input.claimId ?? null,
                });
            result.kind = input.kind;
            result.active = true;
            if (!previous) state.current.push(result);
            return route.fulfill({ json: result });
        }
        if (url.pathname.startsWith('/api/v1/feedback/') && request.method() === 'DELETE') {
            const result = state.current.find((entry) => url.pathname.endsWith(entry.id))!;
            result.active = false;
            return route.fulfill({ json: result });
        }
        return fail(404);
    });
    return { state, calls };
}
const panel = (page: Page) => page.getByRole('region', { name: '本报告的反馈作用', exact: true });
const records = (page: Page) => panel(page).locator('.effect-item');
const actions = (page: Page) => page.getByRole('region', { name: '调整后续研究', exact: true });
async function open(page: Page) {
    await page.goto(path);
    await expect(panel(page)).toBeVisible();
}
async function staleBack(page: Page) {
    await page.getByRole('link', { name: '阅读外观', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 31000));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
}
async function capture(page: Page, info: TestInfo, name: string) {
    await info.attach(name, {
        body: await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true }),
        contentType: 'image/png',
    });
}
test.beforeAll(async ({ browser }) => console.log(`Browser: Chromium ${browser.version()}`));

test('saved effects: all nine states and identical duplicates preserve array order and snapshot intent', async ({
    page,
}) => {
    const { state, calls } = await samples(page.context());
    const report = state.reports[path]!;
    const duplicate = structuredClone(report.feedbackEffects![1]!);
    report.feedbackEffects!.push(duplicate);
    await open(page);
    await expect(records(page)).toHaveCount(10);
    expect(await records(page).locator('h3').allTextContents()).toEqual([
        ...labels.map(([, label]) => label),
        labels[1]![1],
    ]);
    expect(await records(page).locator(':scope > p.effect-text').allTextContents()).toEqual(
        report.feedbackEffects!.map((entry) => entry.reason),
    );
    expect(await records(page).locator(':scope > p:not(.effect-text)').allTextContents()).toEqual(
        report.feedbackEffects!.map(
            (entry) =>
                `反馈意图：${entry.kind === 'known' ? '已了解' : entry.kind === 'deeper' ? '希望深入' : '不相关'}`,
        ),
    );
    await expect(records(page).nth(1)).toContainText('目标来源已优先采集');
    await expect(records(page).nth(6)).toContainText('未执行：预算不足');
    expect(await records(page).locator('h3.scova-partial').allTextContents()).toEqual(
        labels.slice(6).map(([, label]) => label),
    );
    await expect(actions(page)).toBeVisible();
    await expect.poll(() => calls.filter((call) => call.path.endsWith('/feedback')).length).toBe(1);
    expect(calls.map((call) => [call.method, call.path])).toEqual([
        ['GET', '/api/v1/me'],
        ['GET', `/api/v1/reports/${id(1)}`],
        ['GET', `/api/v1/tasks/${id(2)}/feedback`],
    ]);
    await expect(panel(page).locator('button, img, input, select')).toHaveCount(0);
});

test('saved effects: typed same UUID resolves source versus claim, missing historical targets stay identity-only', async ({
    page,
}) => {
    const { state } = await samples(page.context());
    state.reports[path]!.feedbackEffects = [
        effect(),
        effect({ targetType: 'claim' }),
        effect({ targetId: id(99) }),
        effect({ targetType: 'claim', targetId: id(20) }),
    ];
    await open(page);
    const names = ['本报告资料的真实标题', state.reports[path]!.claims[0]!.text];
    for (const index of [0, 1, 2, 3]) {
        const record = records(page).nth(index);
        await record.locator('summary').press('Enter');
        const content = record
            .locator('.effect-details > div')
            .filter({ has: page.locator('dt', { hasText: /^(资料|结论)内容$/ }) });
        if (index < 2) await expect(content.locator('dd')).toHaveText(names[index]!);
        else await expect(content).toHaveCount(0);
        await expect(record).toContainText(index % 2 ? '结论标识' : '资料标识');
        await expect(record.locator('.effect-details')).toContainText(
            state.reports[path]!.feedbackEffects![index]!.targetId,
        );
    }
});

for (const empty of ['absent', 'empty'] as const) {
    test(`saved effects: ${empty} field hides entire panel without inferring current active feedback`, async ({
        page,
    }) => {
        const { state } = await samples(page.context());
        if (empty === 'absent') delete state.reports[path]!.feedbackEffects;
        else state.reports[path]!.feedbackEffects = [];
        await page.goto(path);
        await expect(page.locator('.report-brief')).toBeVisible();
        await expect(panel(page)).toHaveCount(0);
        await expect(actions(page)).toBeVisible();
        await actions(page)
            .getByLabel('选择反馈资料或结论')
            .selectOption(`source:${id(10)}`);
        await expect(actions(page).locator('.selected-target')).toContainText('当前反馈：已了解');
    });
}

test('saved effects: current set/revoke and later report never rewrite the old report snapshot or facts', async ({
    page,
}) => {
    const { state, calls } = await samples(page.context());
    const saved = structuredClone(state.reports[path]!);
    await open(page);
    const originalPanel = await panel(page).textContent();
    const originalBrief = await page.locator('.report-brief').textContent();
    await actions(page)
        .getByLabel('选择反馈资料或结论')
        .selectOption(`source:${id(10)}`);
    await actions(page).getByRole('button', { name: '不相关', exact: true }).click();
    await expect(actions(page).locator('.selected-target')).toContainText('当前反馈：不相关');
    expect(await panel(page).textContent()).toBe(originalPanel);
    await actions(page).getByRole('button', { name: '撤销所选反馈', exact: true }).press('Enter');
    await expect(actions(page).locator('.selected-target')).toContainText('当前反馈：未设置');
    expect(await panel(page).textContent()).toBe(originalPanel);
    expect(await page.locator('.report-brief').textContent()).toBe(originalBrief);
    await page.goto(nextPath);
    await expect(page.locator('.report-brief')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await page.goBack();
    await expect(panel(page)).toBeVisible();
    expect(await panel(page).textContent()).toBe(originalPanel);
    await expect(page.getByRole('note', { name: '部分交付警告' })).toBeVisible();
    await expect(page.locator('#claims-fact')).toHaveText('来源事实');
    await expect(
        page.locator('.report-brief').getByText(saved.claims[0]!.text, { exact: true }),
    ).toBeVisible();
    await page.locator('details.evidence summary').first().press('Enter');
    await expect(page.locator('blockquote').first()).toHaveText(saved.evidence[0]!.quote);
    expect(state.reports[path]).toEqual(saved);
    expect(calls.filter((call) => call.method !== 'GET').map((call) => call.path)).toEqual([
        '/api/v1/feedback',
        `/api/v1/feedback/${id(30)}`,
    ]);
    // #73 does not include #17's changes panel: DTO change flags/values are not invented UI coverage.
    expect(saved.changes.map((change) => [change.kind, change.important])).toEqual([
        ['changed', true],
        ['new', true],
    ]);
});

test('saved effects: current feedback read failure leaves authorized historical effects readable', async ({
    page,
}) => {
    const { state } = await samples(page.context());
    state.feedbackFailure = 503;
    await open(page);
    await expect(actions(page).getByRole('alert')).toContainText('反馈暂时无法读取');
    await expect(records(page)).toHaveCount(9);
    await expect(page.locator('.report-brief')).toBeVisible();
});

test('saved effects: full raw reason/query/URL are inert text, keyboard details and source link are safe', async ({
    page,
}) => {
    const { state } = await samples(page.context());
    const payload =
        '<img src="https://example.test/injected.png" onerror="window.effectsExecuted=true"><script>window.effectsExecuted=true</script>';
    const reason = `  原始原因\n${payload}\t保留末尾空白  `;
    const query = `  原始查询\n第二行${payload}\t  `;
    const url = `https://example.test/${'unbroken-source'.repeat(20)}?q=%3Cscript%3E#original`;
    state.reports[path]!.feedbackEffects = [effect({ reason, query, url })];
    const external: string[] = [];
    page.on('request', (request) => {
        if (request.url().startsWith('https://example.test/')) external.push(request.url());
    });
    await open(page);
    const record = records(page).first();
    expect(await record.locator(':scope > .effect-text').textContent()).toBe(reason);
    expect(
        await record
            .locator(':scope > .effect-text')
            .evaluate((element) => getComputedStyle(element).whiteSpace),
    ).toBe('pre-wrap');
    const summary = record.locator('summary');
    await summary.focus();
    await summary.press('Enter');
    expect(await summary.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
        'none',
    );
    const queryValue = record
        .locator('.effect-details > div')
        .filter({ has: page.locator('dt', { hasText: '本条记录的查询' }) })
        .locator('dd');
    expect(await queryValue.textContent()).toBe(query);
    const link = record.getByRole('link');
    await summary.press('Tab');
    await expect(link).toBeFocused();
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveText(`${url}（在新窗口打开）`);
    await expect(panel(page).locator('script, img, iframe')).toHaveCount(0);
    expect(await page.evaluate(() => 'effectsExecuted' in window)).toBe(false);
    expect(external).toEqual([]);
    await summary.press('Space');
    await expect(queryValue).toBeHidden();
});

test('saved effects: all 600 legal entries and full 1000/2000 boundary fields remain reachable', async ({
    page,
}) => {
    const { state } = await samples(page.context());
    const boundary = effect({ reason: '原'.repeat(1000), query: '查'.repeat(2000) });
    state.reports[path]!.feedbackEffects = Array.from({ length: 600 }, () => ({ ...boundary }));
    await open(page);
    await expect(records(page)).toHaveCount(600);
    const last = records(page).last();
    await last.scrollIntoViewIfNeeded();
    expect(await last.locator(':scope > .effect-text').textContent()).toBe(boundary.reason);
    await last.locator('summary').press('Enter');
    const query = last
        .locator('.effect-details > div')
        .filter({ has: page.locator('dt', { hasText: '本条记录的查询' }) })
        .locator('dd');
    expect(await query.textContent()).toBe(boundary.query);
    await expect(query).toBeVisible();
    expect(
        await last.locator(':scope > .effect-text').evaluate((element) => ({
            clamp: getComputedStyle(element).webkitLineClamp,
            overflow: getComputedStyle(element).overflowY,
        })),
    ).toEqual({ clamp: 'none', overflow: 'visible' });
});

for (const fault of [403, 404, 409, 503, 'protocol', 'invalid'] as const) {
    test(`saved effects: cached report ${fault} hides whole report and effects without partial leakage`, async ({
        page,
    }) => {
        const { state } = await samples(page.context());
        await page.clock.install();
        await open(page);
        await records(page).first().locator('summary').click();
        state.failure = fault;
        await staleBack(page);
        await expect(page.getByRole('status')).toContainText(
            fault === 403
                ? '无权'
                : fault === 404
                  ? '不存在'
                  : fault === 409
                    ? '证据校验未通过'
                    : fault === 'invalid'
                      ? '结构或引用不完整'
                      : '暂时无法读取',
        );
        await expect(
            page.locator('.report-brief, .feedback-effects, .feedback-actions, blockquote'),
        ).toHaveCount(0);
        const retry = page.getByRole('button', { name: '重试', exact: true });
        if (fault === 403 || fault === 404) await expect(retry).toHaveCount(0);
        else {
            state.failure = null;
            await retry.press('Enter');
            await expect(panel(page)).toBeVisible();
            await expect(page.locator('#report-title')).toBeFocused();
        }
    });
}

test('saved effects: invalid 601-item array and unsafe URL are rejected by the actual Report boundary', async ({
    page,
}) => {
    const { state } = await samples(page.context());
    for (const entries of [
        Array.from({ length: 601 }, () => effect()),
        [effect({ url: 'javascript:alert(1)' })],
    ]) {
        state.reports[path]!.feedbackEffects = entries;
        await page.goto(path);
        await expect(page.getByRole('status')).toContainText('结构或引用不完整');
        await expect(
            page.locator('.report-brief, .feedback-effects, .feedback-actions'),
        ).toHaveCount(0);
    }
});

for (const late of [200, 401]) {
    test(`saved effects: late old-account report${late} cannot restore old effects or expire replacement account`, async ({
        page,
    }) => {
        const { state, calls } = await samples(page.context());
        await page.clock.install();
        await open(page);
        let release!: () => void;
        state.reportWait = new Promise<void>((resolve) => {
            release = resolve;
        });
        state.lateStatus = late;
        await staleBack(page);
        await expect
            .poll(() => calls.filter((call) => call.path === `/api/v1/reports/${id(1)}`).length)
            .toBe(2);
        await page.getByRole('button', { name: '退出登录' }).click();
        await page.getByLabel('邮箱', { exact: true }).fill('other@example.test');
        await page.getByLabel('密码', { exact: true }).fill('local-only-password');
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('报告不存在或当前账号无法访问');
        release();
        await expect(
            page.locator('.report-brief, .feedback-effects, .feedback-actions'),
        ).toHaveCount(0);
        await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
        expect(state.owner).toBe(901);
    });
}

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`saved effects ${width}: light/dark, long targets and 200% root text`, async ({
        page,
    }, info) => {
        const { state, calls } = await samples(page.context());
        const report = state.reports[path]!;
        report.evidence[0]!.title = '持续跟踪申请条件与研究资料的来源标题：'.repeat(8);
        report.feedbackEffects = [
            effect({
                reason: '已优先采集目标来源正文。'.repeat(15),
                query: '原始深入查询：'.repeat(20),
                url: `https://example.test/${'long-source-path'.repeat(18)}`,
            }),
            effect({
                effect: 'not_applied_budget',
                reason: '基础问题已占用搜索预算，未执行深入查询；正文采集单独说明。',
            }),
            effect({
                effect: 'not_applied_unmatched',
                targetType: 'claim',
                targetId: id(99),
                reason: '本次未匹配该历史结论，不能声称已调整。',
            }),
        ];
        const errors: string[] = [];
        const external: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
            if (request.url().includes('example.test')) external.push(request.url());
        });
        await page.setViewportSize({ width, height: 1000 });
        await open(page);
        await records(page).first().locator('summary').press('Enter');
        await page.evaluate(() => document.fonts.ready);
        for (const dark of [false, true]) {
            await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
            await expect(page.locator('.scova-theme--dark')).toHaveCount(dark ? 1 : 0);
            for (const enlarged of [false, true]) {
                await page.evaluate((value) => {
                    document.documentElement.style.fontSize = value ? '200%' : '';
                }, enlarged);
                expect(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                ).toBe(true);
                for (const control of await panel(page).locator('summary, a').all()) {
                    const box = (await control.boundingBox())!;
                    expect(box.x).toBeGreaterThanOrEqual(0);
                    expect(box.x + box.width).toBeLessThanOrEqual(width);
                    expect(box.height).toBeGreaterThanOrEqual(enlarged ? 88 : 44);
                    expect(
                        await control.evaluate((element) => getComputedStyle(element).cursor),
                    ).toBe('pointer');
                }
                expect(
                    await records(page)
                        .first()
                        .locator(':scope > .effect-text')
                        .evaluate((element) => getComputedStyle(element).fontFamily),
                ).toContain('Inter');
                expect(
                    await records(page)
                        .first()
                        .locator(':scope > .effect-text')
                        .evaluate((element) => getComputedStyle(element).cursor),
                ).toBe('auto');
                await expect(records(page).nth(1)).toContainText('未执行：预算不足');
                await expect(records(page).nth(2)).toContainText('未执行：未匹配');
                await panel(page).scrollIntoViewIfNeeded();
                await capture(
                    page,
                    info,
                    `effects-${width}-${dark ? 'dark' : 'light'}${enlarged ? '-text-200' : ''}`,
                );
            }
        }
        expect(external).toEqual([]);
        expect(errors).toEqual([]);
        expect(calls.every((call) => call.method === 'GET')).toBe(true);
    });
}
