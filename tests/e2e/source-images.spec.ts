import { expect, test } from '@playwright/test';

for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(`来源图片与纯文字回退：${width}`, async ({ page, baseURL }, testInfo) => {
        const requests: { method: string; url: string }[] = [];
        const errors: string[] = [];
        page.on('request', (request) =>
            requests.push({ method: request.method(), url: request.url() }),
        );
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/__examples/source-images');
        const withImage = page.locator('.image-case-image');
        const text = page.locator('.image-case-text');
        const failed = page.locator('.image-case-failed');
        await expect(withImage.locator('img')).toBeVisible();
        await expect(failed.locator('figure')).toHaveCount(0);
        await expect(text.locator('img')).toHaveCount(0);
        const report = page.getByRole('region', { name: '报告图示', exact: true });
        await expect(report.locator('img')).toBeVisible();
        await expect(report.locator('img')).toHaveAttribute('alt', /零、五、十公里.*不代表真实/);
        await expect(report.locator('figcaption')).toHaveText('概念图 · Scova 自制');
        for (const double of [false, true]) {
            if (double)
                await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
            for (const item of [withImage, text, failed]) {
                await expect(item.getByRole('heading')).toBeVisible();
                await expect(
                    item.getByRole('button', { name: '查看文字', exact: true }),
                ).toBeVisible();
                expect(await item.locator('img').count()).toBeLessThanOrEqual(1);
            }
            for (const item of [text, failed]) {
                const geometry = await item.evaluate((element) => {
                    const row = element.querySelector('.source-item-content')!;
                    const words = element.querySelector('.source-item-text')!;
                    return {
                        row: row.getBoundingClientRect().width,
                        text: words.getBoundingClientRect().width,
                    };
                });
                expect(Math.abs(geometry.row - geometry.text)).toBeLessThan(1);
                await item.getByRole('button', { name: '查看文字', exact: true }).click();
                await expect(page.getByRole('status')).toContainText(
                    await item.getByRole('heading').innerText(),
                );
            }
            const metrics = await report.locator('img').evaluate((image: HTMLImageElement) => ({
                width: image.getBoundingClientRect().width,
                height: image.getBoundingClientRect().height,
                natural: image.naturalWidth / image.naturalHeight,
                fit: getComputedStyle(image).objectFit,
            }));
            expect(metrics.width / metrics.height).toBeCloseTo(metrics.natural, 2);
            expect(metrics.fit).toBe('contain');
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await testInfo.attach(`source-images-${width}${double ? '-double-text' : ''}`, {
                body: await page.screenshot({
                    path: testInfo.outputPath(`${double ? 'double' : 'normal'}.png`),
                    fullPage: true,
                }),
                contentType: 'image/png',
            });
        }
        const replacement = page.getByRole('region', { name: '图片更新', exact: true });
        await expect(replacement.locator('figure')).toHaveCount(0);
        await replacement.getByRole('button', { name: '换用同源图', exact: true }).click();
        await expect(replacement.locator('img')).toBeVisible();
        await replacement.getByRole('button', { name: '移除图片', exact: true }).click();
        await expect(replacement.locator('figure')).toHaveCount(0);
        expect(requests.every(({ url }) => new URL(url).origin === new URL(baseURL!).origin)).toBe(
            true,
        );
        expect(
            requests
                .filter(({ url }) => new URL(url).pathname.startsWith('/api/'))
                .map(({ method, url }) => ({ method, path: new URL(url).pathname })),
        ).toEqual([{ method: 'GET', path: '/api/v1/me' }]);
        expect(errors).toEqual([]);
    });
}

test('图片请求失败后移除已有列，保留纯文字动作', async ({ page }) => {
    await page.route('**/source-map*.svg', (route) => route.abort('failed'));
    await page.goto('/__examples/source-images');
    const item = page.locator('.image-case-image');
    await expect(item.locator('figure')).toHaveCount(0);
    await item.getByRole('button', { name: '查看文字', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('有图条目：流域资料摘录');
    expect(await item.locator('img').count()).toBe(0);
});
