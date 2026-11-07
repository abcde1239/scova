import { expect, test, type Page } from '@playwright/test';

type ViewportSample = { width: number; height: number; offsetLeft: number; offsetTop: number };

async function setVisibleViewport(page: Page, sample: ViewportSample, event: 'resize' | 'scroll') {
    await page.evaluate(
        ({ sample, event }) => {
            Object.assign(window.visualViewport!, sample);
            window.visualViewport!.dispatchEvent(new Event(event));
        },
        { sample, event },
    );
}

async function expectInsideViewport(page: Page, viewport: ViewportSample) {
    const panel = page.getByRole('dialog', { name: '选择默认时区', exact: true });
    await expect(panel).toBeVisible();
    await expect
        .poll(async () => {
            const box = await panel.boundingBox();
            return (
                !!box &&
                box.x >= viewport.offsetLeft &&
                box.y >= viewport.offsetTop &&
                box.x + box.width <= viewport.offsetLeft + viewport.width + 1 &&
                box.y + box.height <= viewport.offsetTop + viewport.height + 1
            );
        })
        .toBe(true);
    await expect(
        page.getByRole('combobox', { name: '搜索默认时区', exact: true }),
    ).toBeInViewport();
}

test.beforeEach(async ({ page }) => {
    // Models the VisualViewport events caused by an on-screen keyboard/panning.
    // This is a controlled API sample, not physical iOS/Android keyboard validation.
    await page.addInitScript(() => {
        const viewport = Object.assign(new EventTarget(), {
            width: innerWidth,
            height: innerHeight,
            offsetLeft: 0,
            offsetTop: 0,
            scale: 1,
        });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await page.route('**/api/v1/me', (route) =>
        route.fulfill({
            status: 401,
            json: { code: 'UNAUTHORIZED', message: '请先登录', requestId: 'mobile-select' },
        }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
});

for (const scale of [100, 200]) {
    test(`搜索下拉在可见区域缩小与平移后仍可选择（${scale}%文字，受控键盘样本）`, async ({
        page,
    }, info) => {
        let writes = 0;
        page.on('request', (request) => {
            if (request.method() !== 'GET') writes++;
        });
        await page.goto('/register');
        await page.evaluate((scale) => {
            document.documentElement.style.fontSize = `${scale}%`;
        }, scale);
        const trigger = page.getByRole('button', { name: '默认时区', exact: true });
        const initial = await trigger.textContent();
        await trigger.click();
        const search = page.getByRole('combobox', { name: '搜索默认时区', exact: true });
        await search.fill('东京');
        const keyboard = { width: 350, height: 280, offsetLeft: 20, offsetTop: 80 };
        await setVisibleViewport(page, keyboard, 'resize');
        await expectInsideViewport(page, keyboard);
        await expect(search).toHaveValue('东京');
        await expect(search).toBeFocused();
        await expect(trigger).toHaveText(initial!);
        const panned = { ...keyboard, offsetTop: 160 };
        await setVisibleViewport(page, panned, 'scroll');
        await expectInsideViewport(page, panned);
        await page.screenshot({ path: info.outputPath('visible-viewport.png') });
        const option = page.getByRole('option', { name: /东京/ });
        await expect(option).toBeVisible();
        if (scale === 200) await option.click();
        else await search.press('Enter');
        await expect(trigger).toContainText('Asia/Tokyo');
        await expect(trigger).toBeFocused();
        expect(writes).toBe(0);
    });
}

test('可见区域变化后取消保留原值，重新打开不继承旧搜索', async ({ page }) => {
    await page.goto('/register');
    const trigger = page.getByRole('button', { name: '默认时区', exact: true });
    const initial = await trigger.textContent();
    await trigger.click();
    const search = page.getByRole('combobox', { name: '搜索默认时区', exact: true });
    await search.fill('伦敦');
    await setVisibleViewport(
        page,
        { width: 390, height: 240, offsetLeft: 0, offsetTop: 180 },
        'resize',
    );
    await expect(search).toHaveValue('伦敦');
    await search.press('Escape');
    await expect(trigger).toHaveText(initial!);
    await expect(trigger).toBeFocused();
    await setVisibleViewport(
        page,
        { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 },
        'resize',
    );
    await trigger.click();
    await expect(search).toHaveValue('');
    await search.fill('伦敦');
    await search.press('Enter');
    await expect(trigger).toContainText('Europe/London');
});

test('键盘选中的选项在可见区域缩小后仍在列表内', async ({ page }) => {
    await page.goto('/register');
    await page.getByRole('button', { name: '默认时区', exact: true }).click();
    const search = page.getByRole('combobox', { name: '搜索默认时区', exact: true });
    for (let index = 0; index < 8; index++) await search.press('ArrowDown');
    const activeId = await search.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const keyboard = { width: 390, height: 240, offsetLeft: 0, offsetTop: 140 };
    await setVisibleViewport(page, keyboard, 'resize');
    await expectInsideViewport(page, keyboard);
    await expect(search).toHaveAttribute('aria-activedescendant', activeId!);
    await expect
        .poll(async () => {
            const option = await page.locator(`[id="${activeId}"]`).boundingBox();
            const list = await page
                .getByRole('listbox', { name: '默认时区', exact: true })
                .boundingBox();
            return (
                !!option &&
                !!list &&
                option.y >= list.y - 1 &&
                option.y + option.height <= list.y + list.height + 1
            );
        })
        .toBe(true);
    await expect(search).toBeFocused();
});

test('不支持 VisualViewport 时按窗口定位，调整尺寸后仍可选择', async ({ page }) => {
    await page.goto('/register');
    await page.evaluate(() => {
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    });
    await page.setViewportSize({ width: 320, height: 600 });
    const trigger = page.getByRole('button', { name: '默认时区', exact: true });
    await trigger.click();
    await page.setViewportSize({ width: 320, height: 640 });
    await expectInsideViewport(page, { width: 320, height: 640, offsetLeft: 0, offsetTop: 0 });
    const search = page.getByRole('combobox', { name: '搜索默认时区', exact: true });
    await search.fill('东京');
    await search.press('Enter');
    await expect(trigger).toContainText('Asia/Tokyo');
    await expect(trigger).toBeFocused();
});
