import { expect, test, type Page } from '@playwright/test';
import type { AgentProvider, AgentProviderInput, SearchConfiguration } from '@scova/models';
import { chooseOption } from './support/select.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = {
    user: {
        id: id(1),
        email: 'provider@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-11-04T00:00:00Z',
    },
    csrfToken: 'sample-csrf',
};
function provider(n: number, active = false): AgentProvider {
    return {
        id: id(n),
        name: n === 2 ? '日常研究' : '备用模型',
        model: 'research-model',
        baseUrl: 'https://api.example.test/v1',
        protocol: 'openai_chat_completions',
        active,
        draftActive: active,
        hasApiKey: true,
        revision: 1,
        updatedAt: '2026-11-04T00:00:00Z',
    };
}
async function samples(
    page: Page,
    initial = [provider(2, true), provider(3)],
    storageReady = true,
) {
    let items = structuredClone(initial);
    const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
    await page.route('**/api/v1/me', (route) => route.fulfill({ json: account }));
    let searchConfiguration: SearchConfiguration | null = null;
    await page.route('**/api/v1/me/search-configuration**', async (route) => {
        const request = route.request();
        if (request.method() === 'GET')
            return route.fulfill({ json: { configuration: searchConfiguration, storageReady } });
        const body = request.postDataJSON();
        const path = new URL(request.url()).pathname;
        writes.push({ method: request.method(), path, body });
        expect((await request.allHeaders())['x-csrf-token']).toBe('sample-csrf');
        if (path.includes('/import/')) {
            const source = items.find((item) => path.endsWith(item.id))!;
            searchConfiguration = {
                revision: (searchConfiguration?.revision ?? 0) + 1,
                defaultMode: 'api',
                api: { ...source.searchApi!, hasApiKey: true },
                updatedAt: '2026-11-11T00:00:00Z',
            };
        } else {
            searchConfiguration = {
                revision: (searchConfiguration?.revision ?? 0) + 1,
                defaultMode: body.defaultMode,
                api: body.api
                    ? {
                          protocol: body.api.protocol,
                          baseUrl: body.api.baseUrl,
                          contentMode: body.api.contentMode,
                          hasApiKey: true,
                      }
                    : (searchConfiguration?.api ?? null),
                updatedAt: '2026-11-11T00:00:00Z',
            };
        }
        return route.fulfill({ json: searchConfiguration });
    });
    await page.route('**/api/v1/me/agent-providers**', async (route) => {
        const request = route.request(),
            path = new URL(request.url()).pathname;
        if (request.method() === 'GET')
            return route.fulfill({ json: { items, systemConfigured: false, storageReady } });
        const body = request.postDataJSON();
        if (path.endsWith('/models'))
            return route.fulfill({
                json: {
                    items: [
                        { id: 'research-model', name: 'Research' },
                        { id: 'updated-model', name: 'Updated' },
                        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
                    ],
                    truncated: false,
                },
            });
        writes.push({ method: request.method(), path, body });
        expect((await request.allHeaders())['x-csrf-token']).toBe('sample-csrf');
        if (request.method() === 'POST' && !path.endsWith('/activate')) {
            const input = body as AgentProviderInput;
            const entry = {
                ...provider(4),
                name: input.name,
                model: input.model,
                baseUrl: input.baseUrl,
                protocol: input.protocol,
            };
            items.push(entry);
            return route.fulfill({ status: 201, json: entry });
        }
        const entry = items.find((p) => path.includes(p.id))!;
        if (path.endsWith('/activate')) {
            const key = body.purpose === 'task_draft' ? 'draftActive' : 'active';
            items.forEach((p) => {
                if (p[key] || p.id === entry.id) p.revision++;
                p[key] = p.id === entry.id;
            });
        } else if (request.method() === 'PATCH') {
            Object.assign(entry, {
                name: body.name,
                model: body.model,
                baseUrl: body.baseUrl,
                protocol: body.protocol,
                revision: entry.revision + 1,
            });
        } else {
            items = items.filter((p) => p.id !== entry.id);
            return route.fulfill({ status: 204 });
        }
        return route.fulfill({ json: entry });
    });
    return writes;
}
for (const width of [1440, 320]) {
    test(`独立搜索配置${width}：账号保存、密钥保留、模型切换互不影响`, async ({ page }, info) => {
        const writes = await samples(page);
        await page.setViewportSize({ width, height: 1100 });
        await page.emulateMedia({
            colorScheme: width === 320 ? 'dark' : 'light',
            reducedMotion: 'reduce',
        });
        await page.goto('/account/agent');
        await expect(page.getByRole('region', { name: '解析模型', exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: '任务执行模型', exact: true })).toBeVisible();
        const search = page.getByRole('region', { name: '搜索与正文提取', exact: true });
        await expect(search).toContainText('内置 SearXNG＋网页读取工具（默认）');
        await search.getByRole('button', { name: '配置搜索', exact: true }).click();
        await chooseOption(page, '账号搜索方式', 'Search API（搜索与网页读取）');
        await expect(page.getByLabel('搜索 API 地址', { exact: true })).toHaveValue(
            'https://api.deepseek.com/v1',
        );
        await page.getByLabel('搜索 API Key', { exact: true }).fill('fixture-search-secret');
        await expect(page.getByLabel('网页正文读取', { exact: true })).toHaveCount(0);
        await expect(search).toContainText('搜索与网页正文均由所选 API 提供');
        expect(await page.getByLabel('搜索 API Key', { exact: true }).getAttribute('type')).toBe(
            'password',
        );
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await page.screenshot({
            path: info.outputPath('independent-search-form.png'),
            fullPage: true,
        });
        await search.getByRole('button', { name: '保存搜索配置', exact: true }).click();
        await expect(search).toContainText('DeepSeek Search');
        expect(writes[0]).toMatchObject({
            method: 'PUT',
            path: '/api/v1/me/search-configuration',
            body: {
                defaultMode: 'api',
                api: {
                    protocol: 'deepseek',
                    apiKey: 'fixture-search-secret',
                    contentMode: 'prefer_api',
                },
            },
        });
        expect(writes[0]?.body).not.toHaveProperty('apiKey');
        await chooseOption(page, '任务执行使用的配置', '备用模型');
        await expect(search).toContainText('DeepSeek Search');
        expect(writes[1]?.path).toContain('/agent-providers/');
        await search.getByRole('button', { name: '编辑搜索配置', exact: true }).click();
        await expect(
            page.getByLabel('搜索 API Key（地址与协议不变时留空保留）', { exact: true }),
        ).toHaveValue('');
        await expect(page.getByLabel('网页正文读取', { exact: true })).toHaveCount(0);
        await search.getByRole('button', { name: '保存搜索配置', exact: true }).click();
        expect(writes[2]?.body.api).not.toHaveProperty('apiKey');
        await search.getByRole('button', { name: '编辑搜索配置', exact: true }).click();
        await chooseOption(page, '账号搜索方式', '内置 SearXNG＋网页读取工具');
        await search.getByRole('button', { name: '保存搜索配置', exact: true }).click();
        expect(writes[3]?.body).toEqual({ revision: 2, defaultMode: 'searxng' });
        await expect(search).toContainText('内置 SearXNG＋网页读取工具');
        await page.screenshot({
            path: info.outputPath('three-independent-groups.png'),
            fullPage: true,
        });
    });
    test(`旧搜索迁入${width}：迁入后模型编辑不写搜索，删除模型保留搜索`, async ({ page }, info) => {
        const old = provider(2, true);
        old.searchApi = {
            protocol: 'tavily',
            baseUrl: 'https://api.tavily.com',
            contentMode: 'reader',
            hasApiKey: true,
        };
        const writes = await samples(page, [old, provider(3)]);
        await page.setViewportSize({ width, height: 1100 });
        await page.goto('/account/agent');
        const search = page.getByRole('region', { name: '搜索与正文提取', exact: true });
        await chooseOption(page, '迁入搜索配置的供应商', '日常研究');
        await search.getByRole('button', { name: '迁入搜索配置', exact: true }).click();
        await expect(search).toContainText('Tavily Search');
        expect(writes[0]).toMatchObject({
            method: 'POST',
            path: '/api/v1/me/search-configuration/import/' + old.id,
            body: { providerRevision: 1 },
        });
        const card = page
            .getByRole('listitem')
            .filter({ has: page.getByRole('heading', { name: '日常研究', exact: true }) });
        await card.getByRole('button', { name: '编辑', exact: true }).click();
        await expect(
            page.locator('.provider-form').getByLabel('研究搜索方式', { exact: true }),
        ).toHaveCount(0);
        await expect(
            page.locator('.provider-form').getByLabel('搜索 API 地址', { exact: true }),
        ).toHaveCount(0);
        await page.getByRole('button', { name: '保存配置', exact: true }).click();
        expect(writes[1]?.body).not.toHaveProperty('searchApi');
        expect(writes[1]?.body).not.toHaveProperty('webSearch');
        await expect(search).toContainText('Tavily Search');
        page.once('dialog', (dialog) => dialog.accept());
        await card.getByRole('button', { name: '删除', exact: true }).click();
        await expect(search).toContainText('Tavily Search');
        await page.screenshot({
            path: info.outputPath('search-independent-after-delete.png'),
            fullPage: true,
        });
    });
}
for (const width of [1440, 320]) {
    test(`模型列表${width}：加载、搜索选择、刷新与保存，支持深色和200%文字`, async ({
        page,
    }, info) => {
        const writes = await samples(page, []);
        const reads: Record<string, unknown>[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route('**/api/v1/me/agent-providers/models', async (route) => {
            reads.push(route.request().postDataJSON());
            if (reads.length === 1) await gate;
            await route.fulfill({
                json: {
                    items: [
                        { id: 'model-a', name: '研究模型 Alpha' },
                        { id: 'model-b', name: '研究模型 Beta' },
                    ],
                    truncated: false,
                },
            });
        });
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({
            colorScheme: width === 320 ? 'dark' : 'light',
            reducedMotion: 'reduce',
        });
        await page.goto('/account/agent');
        await page.getByRole('button', { name: '添加供应商', exact: true }).click();
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        await expect(page.getByLabel('模型 ID', { exact: true })).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: '获取模型列表', exact: true }),
        ).toBeDisabled();
        await page.getByLabel('配置名称', { exact: true }).fill('目录测试');
        await page.getByLabel('API Key', { exact: true }).fill('fixture-secret');
        await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
        await expect(
            page.getByRole('status').filter({ hasText: '正在读取供应商模型列表' }),
        ).toBeVisible();
        const busy = page.getByRole('button', { name: '正在读取模型列表', exact: true });
        await expect(busy).toHaveAttribute('aria-disabled', 'true');
        await busy.dispatchEvent('click');
        expect(reads).toHaveLength(1);
        await page.screenshot({
            path: info.outputPath(`models-loading-${width}.png`),
            fullPage: true,
            animations: 'disabled',
        });
        release();
        await expect(page.locator('.provider-models')).toContainText('已读取 2 个模型');
        await page.getByLabel('模型', { exact: true }).click();
        await page.getByRole('combobox', { name: '搜索模型', exact: true }).fill('model-b');
        await expect(page.getByRole('option')).toHaveCount(1);
        await page.screenshot({
            path: info.outputPath(`models-search-${width}.png`),
            // 全页截图会滚动长表单，使离开视口的固定下拉浮层按设计关闭。
            fullPage: false,
            animations: 'disabled',
        });
        await page.getByRole('combobox', { name: '搜索模型', exact: true }).press('Enter');
        await expect(page.getByLabel('模型', { exact: true })).toContainText('研究模型 Beta');
        await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
        await expect(page.locator('.provider-models')).toContainText('已读取 2 个模型');
        await expect(page.getByLabel('模型', { exact: true })).toContainText('研究模型 Beta');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        expect(reads).toHaveLength(2);
        await page.screenshot({
            path: info.outputPath(`models-selected-${width}.png`),
            fullPage: true,
            animations: 'disabled',
        });
        await page.getByRole('button', { name: '保存配置', exact: true }).click();
        await expect(page.getByRole('heading', { name: '目录测试', exact: true })).toBeVisible();
        expect(writes).toHaveLength(1);
        expect(writes[0]!.body.model).toBe('model-b');
    });
}

test('模型目录失败可重试、空列表可手工回退，保留配置和密钥且不误退出', async ({ page }, info) => {
    const writes = await samples(page, []);
    let reads = 0;
    await page.route('**/api/v1/me/agent-providers/models', (route) => {
        reads++;
        return route.fulfill(
            reads === 1
                ? {
                      status: 422,
                      json: {
                          code: 'MODEL_CATALOG_AUTH',
                          message: '供应商拒绝访问，请检查密钥与模型列表权限',
                          requestId: 'sample',
                      },
                  }
                : { json: { items: [], truncated: false } },
        );
    });
    await page.goto('/account/agent');
    await page.getByRole('button', { name: '添加供应商', exact: true }).click();
    await page.getByLabel('配置名称', { exact: true }).fill('私有别名');
    await page.getByLabel('API Key', { exact: true }).fill('fixture-secret');
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(page.locator('.provider-models').getByRole('alert')).toContainText(
        '供应商拒绝访问',
    );
    await expect(page).toHaveURL(/\/account\/agent$/);
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('fixture-secret');
    await page.screenshot({ path: info.outputPath('models-error.png'), fullPage: true });
    await page.getByRole('button', { name: '重试获取模型列表', exact: true }).click();
    await expect(page.locator('.provider-models')).toContainText('未返回可选模型');
    await page.getByRole('button', { name: '手动输入模型 ID', exact: true }).click();
    await page.getByLabel('模型 ID', { exact: true }).fill('private-alias');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '私有别名', exact: true })).toBeVisible();
    expect(writes[0]!.body.model).toBe('private-alias');
    expect(reads).toBe(2);
});

test('编辑自动用本人已存凭据请求目录，改变地址必须重填，旧模型不被自动替换', async ({ page }) => {
    const writes = await samples(page);
    const reads: Record<string, unknown>[] = [];
    await page.route('**/api/v1/me/agent-providers/models', (route) => {
        reads.push(route.request().postDataJSON());
        return route.fulfill({
            json: { items: [{ id: 'other-model', name: 'Other' }], truncated: true },
        });
    });
    await page.goto('/account/agent');
    await page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: '日常研究', exact: true }) })
        .getByRole('button', { name: '编辑', exact: true })
        .click();
    await expect(page.locator('.provider-models')).toContainText('仅显示部分结果');
    expect(reads[0]).toEqual({
        baseUrl: provider(2).baseUrl,
        protocol: provider(2).protocol,
        providerId: id(2),
        revision: 1,
    });
    await expect(page.getByLabel('模型', { exact: true })).toContainText('research-model');
    await expect(page.getByLabel('模型', { exact: true })).toContainText('列表中未返回');
    await page.getByLabel('API 地址', { exact: true }).fill('https://another.example.test/v1');
    await expect(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeDisabled();
    await page.getByLabel('API Key（留空保留）', { exact: true }).fill('new-fixture-secret');
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(page.locator('.provider-models')).toContainText('仅显示部分结果');
    expect(reads[1]!.apiKey).toBe('new-fixture-secret');
    expect(writes).toHaveLength(0);
});

test('读取期间改变连接或关闭编辑，迟到目录不会覆盖新连接或重新打开的页面', async ({ page }) => {
    await samples(page, []);
    let release!: () => void,
        count = 0;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/v1/me/agent-providers/models', async (route) => {
        count++;
        await gate;
        await route.fulfill({
            json: { items: [{ id: 'old-model', name: '旧连接模型' }], truncated: false },
        });
    });
    await page.goto('/account/agent');
    await page.getByRole('button', { name: '添加供应商', exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('fixture-secret');
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect.poll(() => count).toBe(1);
    await page.getByLabel('API 地址', { exact: true }).fill('https://new.example.test/v1');
    await expect(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled();
    release();
    await expect(page.getByLabel('模型', { exact: true })).toBeDisabled();
    await expect(page.locator('.provider-models')).not.toContainText('已读取');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '添加供应商', exact: true }).click();
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('模型', { exact: true })).toBeDisabled();
    expect(count).toBe(1);
});

test('账号入口唯一；供应商切换、编辑不回显密钥、删除当前项', async ({ page }) => {
    const writes = await samples(page);
    await page.goto('/account');
    await page.getByRole('main').getByRole('link', { name: 'Agent 配置', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/agent$/);
    await expect(page.getByRole('region', { name: '任务执行模型' })).toContainText('日常研究');
    const spare = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: '备用模型' }) });
    await chooseOption(page, '任务执行使用的配置', '备用模型');
    await expect(page.getByRole('region', { name: '任务执行模型' })).toContainText('备用模型');
    await spare.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('API Key（留空保留）', { exact: true })).toHaveValue('');
    await expect(page.locator('.provider-models')).toContainText('已读取 3 个模型');
    await chooseOption(page, '模型', 'Updated');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    expect(writes.at(-1)?.body).not.toHaveProperty('apiKey');
    await expect(spare).toContainText('updated-model');
    page.once('dialog', (d) => d.accept());
    await spare.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('region', { name: '任务执行模型' })).toContainText('尚未配置模型');
    expect(writes.map((w) => w.method)).toEqual(['POST', 'PATCH', 'DELETE']);
});
for (const width of [1440, 390, 320]) {
    test(`新增供应商预设与保存，${width}宽和200%文字`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const writes = await samples(page, []);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/account/agent');
        await expect(page.getByText('暂无供应商', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '添加供应商', exact: true }).click();
        await chooseOption(page, '快速填写', 'DeepSeek（OpenAI 兼容）');
        await expect(page.getByLabel('API 地址', { exact: true })).toHaveValue(
            'https://api.deepseek.com/v1',
        );
        await expect(page.getByLabel('接口协议', { exact: true })).toContainText('JSON 模式');
        await page.getByLabel('API Key', { exact: true }).fill('fixture-secret');
        await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
        await chooseOption(page, '模型', 'DeepSeek Chat');
        await page.screenshot({
            path: testInfo.outputPath(`provider-form-${width}.png`),
            fullPage: true,
        });
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await chooseOption(page, '接口协议', 'OpenAI 兼容 · JSON 模式');
        await page.getByRole('button', { name: '保存配置', exact: true }).click();
        await expect(page.getByRole('list', { name: '我的供应商' })).toContainText('DeepSeek');
        expect(writes[0]?.body).toMatchObject({
            protocol: 'openai_json',
            model: 'deepseek-chat',
            apiKey: 'fixture-secret',
        });
        await page.screenshot({
            path: testInfo.outputPath(`provider-list-${width}-200.png`),
            fullPage: true,
        });
        expect(errors).toEqual([]);
    });
}
test('未保存离开可取消；切换预设清除未保存密钥，重新打开不保留', async ({ page }) => {
    await samples(page);
    await page.goto('/account/agent');
    await page.getByRole('button', { name: '添加供应商', exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('private-draft');
    await chooseOption(page, '快速填写', 'Anthropic');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('API 地址', { exact: true })).toHaveValue(
        'https://api.anthropic.com/v1',
    );
    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存配置' })).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '添加供应商', exact: true }).click();
    await expect(page.getByLabel('配置名称', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
});
test('加密未启用时禁止添加与切换', async ({ page }) => {
    await samples(page, [provider(2)], false);
    await page.goto('/account/agent');
    await expect(
        page.getByText('管理员尚未启用密钥加密，暂时无法添加或切换供应商。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeDisabled();
    await expect(page.getByLabel('任务执行使用的配置', { exact: true })).toBeDisabled();
});

test('模型选择与管理分区；切换失败保留原选择，在途及编辑时禁止再次切换', async ({ page }) => {
    const writes = await samples(page);
    let release!: () => void,
        calls = 0;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route('**/api/v1/me/agent-providers/*/activate', async (route) => {
        calls++;
        if (calls > 1) return route.fallback();
        await gate;
        return route.fulfill({
            status: 503,
            json: { code: 'FAIL', message: 'sample', requestId: 'sample' },
        });
    });
    await page.goto('/account/agent');
    const selection = page.getByRole('region', { name: 'Agent 分工', exact: true });
    const management = page.getByRole('region', { name: '供应商管理', exact: true });
    await expect(selection.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
    await expect(management.getByLabel('任务执行使用的配置', { exact: true })).toHaveCount(0);
    await expect(management.getByLabel('解析使用的配置', { exact: true })).toHaveCount(0);
    await expect(management.getByLabel('额度查询方式', { exact: true })).toHaveCount(2);
    await chooseOption(page, '任务执行使用的配置', '备用模型');
    const research = page.getByLabel('任务执行使用的配置', { exact: true });
    const draft = page.getByLabel('解析使用的配置', { exact: true });
    await expect(research).toBeDisabled();
    await expect(draft).toBeDisabled();
    await expect(management.getByRole('button', { name: '编辑', exact: true })).toHaveCount(2);
    for (const button of await management.getByRole('button', { name: '编辑', exact: true }).all())
        await expect(button).toBeDisabled();
    release();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '切换未确认',
    );
    await expect(research).toBeEnabled();
    await expect(research).toContainText('日常研究');
    await expect(draft).toContainText('日常研究');
    await chooseOption(page, '任务执行使用的配置', '备用模型');
    await expect(research).toContainText('备用模型');
    await expect(draft).toContainText('日常研究');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ revision: 1, purpose: 'research' });
    await management
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: '备用模型', exact: true }) })
        .getByRole('button', { name: '编辑', exact: true })
        .click();
    await expect(research).toBeDisabled();
    await expect(draft).toBeDisabled();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(research).toBeEnabled();
    expect(calls).toBe(2);
});
test('保存结果未知时保留填写并禁止重复提交', async ({ page }) => {
    await samples(page);
    let calls = 0;
    await page.route('**/api/v1/me/agent-providers', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        calls++;
        return route.fulfill({
            status: 503,
            json: { code: 'FAIL', message: 'test', requestId: 'sample' },
        });
    });
    await page.goto('/account/agent');
    await page.getByRole('button', { name: '添加供应商', exact: true }).click();
    await page.getByLabel('配置名称', { exact: true }).fill('我的模型');
    await page.getByRole('button', { name: '手动输入模型 ID', exact: true }).click();
    await page.getByLabel('模型 ID', { exact: true }).fill('model');
    await page.getByLabel('API Key', { exact: true }).fill('fixture-secret');
    await page.getByRole('button', { name: '保存配置' }).click();
    await expect(page.locator('.scova-notifications .n-notification').last()).toContainText(
        '保存结果尚未确认',
    );
    await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('model');
    expect(calls).toBe(1);
});

for (const width of [1440, 320]) {
    test(`需求整理可独立切换并复用研究配置，分工弹窗和焦点 ${width}`, async ({ page }, info) => {
        const writes = await samples(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/account/agent');
        const spare = page
            .getByRole('listitem')
            .filter({ has: page.getByRole('heading', { name: '备用模型' }) });
        await chooseOption(page, '解析使用的配置', '备用模型');
        await expect(page.getByRole('region', { name: '解析模型' })).toContainText('备用模型');
        await expect(page.getByRole('region', { name: '任务执行模型' })).toContainText('日常研究');
        expect(writes[0]?.body.purpose).toBe('task_draft');
        await chooseOption(page, '任务执行使用的配置', '备用模型');
        await expect(spare.getByRole('button', { name: /^用于/ })).toHaveCount(0);
        await expect(page.getByRole('region', { name: '解析模型' })).toContainText('备用模型');
        await expect(page.getByRole('region', { name: '任务执行模型' })).toContainText('备用模型');
        await page.screenshot({ path: info.outputPath('purpose-summary.png'), fullPage: true });
        if (width === 320)
            await page.evaluate(() => {
                document.documentElement.style.fontSize = '200%';
            });
        const help = page.getByRole('button', { name: '模型分工说明' });
        await help.click();
        const modal = page.getByRole('dialog');
        await expect(modal).toContainText('解析 Agent');
        await expect(modal).toContainText('报告问答');
        await expect
            .poll(() => modal.evaluate((el) => el.contains(document.activeElement)))
            .toBe(true);
        await page.keyboard.press('Tab');
        await expect
            .poll(() => modal.evaluate((el) => el.contains(document.activeElement)))
            .toBe(true);
        await page.screenshot({
            path: info.outputPath('purpose-help.png'),
            animations: 'disabled',
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        );
        await page.keyboard.press('Escape');
        await expect(modal).not.toBeVisible();
        await expect(help).toBeFocused();
    });
}
