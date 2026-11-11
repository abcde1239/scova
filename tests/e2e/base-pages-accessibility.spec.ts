import { randomBytes, randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import type { Report, Run } from '@scova/models';
import { expect, test } from './support/environment.ts';
import type { Owner } from './support/environment.ts';
import { auditInteractiveSemantics } from './support/accessibility-audit.ts';

// Real same-origin services and controlled supplier delivery. Text enlargement is measured separately
// from browser zoom and actual screen-reader output, which require manual verification.
async function tabTo(page: Page, target: Locator) {
    for (let index = 0; index < 160; index++) {
        if (await target.evaluate((element) => element === document.activeElement)) {
            await expect(target).toBeInViewport();
            expect(await target.evaluate((element) => element.matches(':focus-visible'))).toBe(
                true,
            );
            return;
        }
        await page.keyboard.press('Tab');
    }
    throw new Error(`Keyboard navigation did not reach ${await target.getAttribute('id')}`);
}

async function checkLayout(page: Page, scale: number) {
    await page.evaluate((value) => {
        document.documentElement.style.fontSize = `${value}%`;
    }, scale);
    await page.evaluate(() => document.fonts.ready);
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        .toBe(true);
    const measurements = await page
        .locator('main input, main textarea, main select')
        .evaluateAll((elements) =>
            elements
                .filter((element) => {
                    const bounds = element.getBoundingClientRect();
                    return bounds.width > 0 && bounds.height > 0;
                })
                .map((element) => {
                    const style = getComputedStyle(element);
                    const bounds = element.getBoundingClientRect();
                    return {
                        name: element.getAttribute('id') ?? element.tagName,
                        textEntry: !element.matches('input[type="checkbox"], input[type="radio"]'),
                        size: parseFloat(style.fontSize),
                        left: bounds.left,
                        right: bounds.right,
                        viewport: innerWidth,
                    };
                }),
        );
    for (const input of measurements) {
        if (input.textEntry)
            expect(input.size, input.name).toBeGreaterThanOrEqual((16 * scale) / 100);
        expect(input.left, input.name).toBeGreaterThanOrEqual(-1);
        expect(input.right, input.name).toBeLessThanOrEqual(input.viewport + 1);
    }
    const targets = await page.locator('main .scova-action-button').evaluateAll((elements) =>
        elements
            .map((element) => ({
                name: element.textContent,
                width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height,
            }))
            .filter((bounds) => bounds.width > 0 && bounds.height > 0),
    );
    for (const target of targets) {
        expect(target.width, target.name ?? '').toBeGreaterThanOrEqual((44 * scale) / 100 - 1);
        expect(target.height, target.name ?? '').toBeGreaterThanOrEqual((44 * scale) / 100 - 1);
    }
    return measurements.length;
}

test('基础页面真实服务六宽、文字放大和浅暗矩阵（实际读屏另验）', async ({
    environment,
    browser,
}, info) => {
    const owner = await environment.owner();
    const config = environment.config();
    config.title = '跨地区招生与研究资料长期跟踪：长中文标题、费用变化与可追溯证据';
    config.goal = '保留来源原文，不将部分交付解释为没有重要变化。'.repeat(8);
    config.schedule = { frequency: 'weekly', weekday: 7, localTime: '23:59' };
    config.sourcePreferences.preferredUrls = [
        `https://example.test/${'long-original-source-path-'.repeat(12)}`,
    ];
    const task = await environment.task(owner, config);
    const delivered = await environment.execute(owner, task.id, 'live');
    const page = owner.page;
    const errors: string[] = [];
    const outside: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
        if (new URL(request.url()).origin !== environment.services.origin)
            outside.push(request.url());
    });
    const cases = [
        { path: '/login', selector: '.login-form' },
        { path: '/register', selector: '.register-form' },
        { path: '/account', selector: '.settings' },
        { path: '/tasks', selector: '.task-list' },
        { path: '/tasks/new', selector: '.task-config-form' },
        { path: `/tasks/${task.id}/edit`, selector: '.task-config-form' },
        { path: `/tasks/${task.id}`, selector: '.task-summary' },
        { path: `/runs/${delivered.run.id}`, selector: '.execution-detail' },
        { path: '/inbox', selector: '.inbox-view' },
        { path: '/notifications', selector: '.notifications-view' },
        { path: `/reports/${delivered.report.id}`, selector: '.report-frame' },
        { path: `/tasks/reports?taskId=${task.id}`, selector: '.report-history' },
        { path: `/reports/${randomUUID()}`, selector: '.state-panel', error: true },
        { path: `/runs/${randomUUID()}`, selector: '.state-panel', error: true },
    ];
    const records: {
        path: string;
        width: number;
        scale: number;
        scheme: string;
        inputs: number;
    }[] = [];
    for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of [1440, 1024, 768, 390, 360, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const scale of [100, 200]) {
                for (const entry of cases) {
                    await test.step(`${scheme}/${width}/${scale} ${entry.path}`, async () => {
                        await page.goto(`${environment.services.origin}${entry.path}`);
                        await expect(page.locator(entry.selector)).toBeVisible();
                        await expect(page.locator('.scova-theme')).toHaveClass(
                            scheme === 'dark' ? /scova-theme--dark/ : /^scova-theme$/,
                        );
                        if ('error' in entry)
                            await expect(page.locator(entry.selector)).toContainText('加载失败');
                        if (entry.selector === '.task-config-form')
                            await page
                                .getByText('关注范围与来源偏好', { exact: true })
                                .press('Enter');
                        const inputs = await checkLayout(page, scale);
                        if (entry.selector === '.report-frame') {
                            await expect(
                                page.getByRole('note', { name: '查阅范围说明' }),
                            ).toBeVisible();
                            const citation = page
                                .locator('.report-frame .evidence-source-group')
                                .first();
                            await citation.locator(':scope > summary').press('Enter');
                            await expect(citation.locator('blockquote')).toBeVisible();
                            await checkLayout(page, scale);
                        }
                        if (width === 320 && scale === 200)
                            await info.attach(`${scheme}-${entry.selector.slice(1)}`, {
                                body: await page.screenshot({ fullPage: true }),
                                contentType: 'image/png',
                            });
                        records.push({ ...entry, width, scale, scheme, inputs });
                    });
                }
            }
        }
    }
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
    await info.attach('base-page-matrix', {
        body: JSON.stringify({
            browser: browser.version(),
            provenance: 'real-services-supplier-fixture',
            rootTextEnlargement: true,
            browserZoomVerified: false,
            screenReaderVerified: false,
            realDeviceVerified: false,
            records,
        }),
        contentType: 'application/json',
    });
});

test('键盘注册、登录、创建、执行、报告引用及菜单返回；鼠标键盘忙碌拦截', async ({
    environment,
    browser,
}) => {
    const context = await browser.newContext({ baseURL: environment.services.origin });
    const page = await context.newPage();
    const email = `${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('hex');
    try {
        await page.goto(`${environment.services.origin}/register`);
        const emailField = page.getByLabel('邮箱', { exact: true });
        await tabTo(page, emailField);
        await page.keyboard.type(email);
        await tabTo(page, page.getByLabel('密码', { exact: true }));
        await page.keyboard.type(password);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/tasks$/);
        const me = await page.evaluate(async () => {
            const response = await fetch('/api/v1/me');
            return response.json() as Promise<{ user: { id: string }; csrfToken: string }>;
        });
        const owner: Owner = { context, page, id: me.user.id, csrf: me.csrfToken };
        await tabTo(page, page.getByRole('button', { name: '账号菜单', exact: true }));
        await page.keyboard.press('Enter');
        await tabTo(page, page.getByRole('button', { name: '退出登录', exact: true }));
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/login(?:\?|$)/);
        let requests = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await page.route('**/api/v1/auth/login', async (route) => {
            requests++;
            await gate;
            await route.continue();
        });
        await tabTo(page, page.getByLabel('邮箱', { exact: true }));
        await page.keyboard.type(email);
        await tabTo(page, page.getByLabel('密码', { exact: true }));
        await page.keyboard.type(password);
        await page.keyboard.press('Enter');
        try {
            const busy = page.getByRole('button', { name: '正在登录', exact: true });
            await expect(busy).toHaveAttribute('aria-disabled', 'true');
            await page.keyboard.press('Enter');
            await page.keyboard.press('Space');
            await busy.click({ force: true });
            expect(requests).toBe(1);
        } finally {
            release();
        }
        await expect(page).toHaveURL(/\/tasks$/);
        await page.unroute('**/api/v1/auth/login');
        await tabTo(page, page.getByRole('link', { name: '新建任务', exact: true }));
        await page.keyboard.press('Enter');
        for (const [label, value] of [
            ['任务标题', '键盘完成的演示任务'],
            ['查阅主题', '开放英语资料'],
            ['查阅目标', '保留原文与费用变化引用'],
        ]) {
            await tabTo(page, page.getByLabel(label!, { exact: true }));
            await page.keyboard.type(value!);
        }
        await tabTo(page, page.getByRole('button', { name: '确认保存任务', exact: true }));
        await page.keyboard.press('Enter');
        await expect(
            page.getByRole('heading', { name: '键盘完成的演示任务', exact: true }),
        ).toBeVisible();
        await tabTo(page, page.getByRole('button', { name: '立即执行', exact: true }));
        await page.keyboard.press('Enter');
        const open = page.getByRole('link', { name: '打开执行', exact: true });
        await expect(open).toBeVisible();
        const runId = (await open.getAttribute('href'))!.split('/').at(-1)!;
        await tabTo(page, open);
        await page.keyboard.press('Enter');
        await expect
            .poll(
                async () => (await environment.request<Run>(owner, `/api/v1/runs/${runId}`)).status,
                {
                    timeout: 90_000,
                },
            )
            .toBe('partial');
        const reports = await environment.request<{ items: { id: string }[] }>(
            owner,
            '/api/v1/reports',
        );
        const report = await environment.request<Report>(
            owner,
            `/api/v1/reports/${reports.items[0]!.id}`,
        );
        expect(report.runId).toBe(runId);
        const reportLink = page.getByRole('link', { name: '查看已发布报告', exact: true });
        await expect(reportLink).toHaveAttribute('href', `/reports/${report.id}`);
        await tabTo(page, reportLink);
        await page.keyboard.press('Enter');
        const summary = page.locator('.report-frame .evidence-source-group > summary').first();
        await tabTo(page, summary);
        await page.keyboard.press('Enter');
        await expect(
            page.locator('.report-frame .evidence-source-group[open] blockquote').first(),
        ).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        const menu = page.getByRole('button', { name: /^打开(个人侧栏|导航菜单)$/, exact: true });
        await tabTo(page, menu);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await expect(menu).toBeFocused();
    } finally {
        await context.close();
    }
});

test('代表工作台页面保持可访问名称、表单关联和状态播报契约', async ({ environment }) => {
    const owner = await environment.owner();
    for (const path of [
        '/tasks',
        '/inbox',
        '/notifications',
        '/library',
        '/library/search',
        '/account',
        '/account/agent',
        '/account/appearance',
        '/tasks/reports',
    ]) {
        await owner.page.goto(path);
        await expect(owner.page.getByRole('main')).toBeVisible();
        expect(await auditInteractiveSemantics(owner.page), path).toEqual([]);
    }
    await owner.context.close();
});
