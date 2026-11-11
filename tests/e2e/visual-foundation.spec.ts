import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockFixtureSession } from './support/session-sample.ts';

test.beforeEach(async ({ page }) => mockFixtureSession(page));

const sourcePaths = [
    'apps/web/tests/fixtures/pages/VisualFoundationExample.vue',
    'apps/web/tests/fixtures/routes.ts',
    'apps/web/src/theme/tokens.ts',
    'apps/web/src/main.css',
    'apps/web/unocss.config.ts',
    'apps/web/src/styles/reading-fonts.css',
    'apps/web/src/components/common/ActionButton.vue',
    'apps/web/src/components/common/AppIcon.vue',
    'apps/web/src/components/common/IconButton.vue',
    'apps/web/src/components/common/StatePanel.vue',
    'tests/e2e/visual-foundation.spec.ts',
    'tests/e2e/visual-foundation.config.ts',
    'pnpm-lock.yaml',
];
const source = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    files: Object.fromEntries(
        sourcePaths.map((path) => [
            path,
            createHash('sha256').update(readFileSync(path)).digest('hex'),
        ]),
    ),
};

async function measureContrast(page: Page) {
    return page
        .locator('.contrast-sample, .state-sample [role="status"]')
        .evaluateAll((elements) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d', { willReadFrequently: true })!;
            const rgba = (color: string) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return Array.from(context.getImageData(0, 0, 1, 1).data);
            };
            const over = (front: number[], back: number[]) => {
                const alpha = front[3]! / 255;
                return [0, 1, 2].map((index) => front[index]! * alpha + back[index]! * (1 - alpha));
            };
            const luminance = (color: number[]) => {
                const linear = color.map((channel) => {
                    const value = channel / 255;
                    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                });
                return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
            };
            return elements.map((element) => {
                const layers: Element[] = [];
                for (let layer: Element | null = element; layer; layer = layer.parentElement)
                    layers.unshift(layer);
                let background = [255, 255, 255];
                for (const layer of layers) {
                    const style = getComputedStyle(layer);
                    if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1)
                        throw new Error(
                            'Contrast sample must have uniform backgrounds and full element opacity',
                        );
                    background = over(rgba(style.backgroundColor), background);
                }
                const style = getComputedStyle(element);
                const foreground = over(rgba(style.color), background);
                const light = luminance(foreground);
                const dark = luminance(background);
                return {
                    text: element.textContent?.trim(),
                    glass: element.closest('.glass-sample')?.className ?? null,
                    foreground,
                    background,
                    ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
                    minimum: element.classList.contains('large-sample') ? 3 : 4.5,
                    fontSize: style.fontSize,
                    fontFamily: style.fontFamily,
                    fontWeight: style.fontWeight,
                };
            });
        });
}

async function platformFonts(page: Page) {
    const session = await page.context().newCDPSession(page);
    try {
        await session.send('DOM.enable');
        await session.send('CSS.enable');
        const { root } = await session.send('DOM.getDocument');
        const result: Record<string, unknown> = {};
        for (const name of ['interface', 'latin', 'reading']) {
            const { nodeId } = await session.send('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: `.font-${name}`,
            });
            const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
            result[name] = fonts;
        }
        return result;
    } finally {
        await session.detach();
    }
}

for (const accent of ['blue', 'pine', 'iris', 'amber']) {
    for (const scheme of ['light', 'dark']) {
        for (const rendering of ['native', 'reduced', 'solid']) {
            test(`${accent}/${scheme}/${rendering} 实际底色、中文字体和图标`, async ({
                page,
                browser,
            }, testInfo) => {
                const errors: string[] = [];
                const blocked: string[] = [];
                page.on('pageerror', (error) => errors.push(error.message));
                const fallback = rendering !== 'native';
                if (fallback)
                    await page.route(/\.woff2?(?:\?|$)/, async (route) => {
                        blocked.push(route.request().url());
                        await route.abort('blockedbyclient');
                    });
                const session = await page.context().newCDPSession(page);
                if (rendering === 'reduced')
                    await session.send('Emulation.setEmulatedMedia', {
                        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
                    });
                const measurements = [];
                let fonts: Record<string, unknown> = {};
                try {
                    for (const backdrop of ['white', 'black', 'blue']) {
                        await page.goto(
                            `/__examples/visual-foundation?accent=${accent}&scheme=${scheme}&backdrop=${backdrop}&rendering=${rendering}`,
                        );
                        await expect(
                            page.getByRole('region', { name: '基础视觉样例' }),
                        ).toBeVisible();
                        await page.evaluate(async () => {
                            await document.fonts.ready;
                            await new Promise(requestAnimationFrame);
                            await Promise.all(
                                document
                                    .getAnimations()
                                    .map((animation) => animation.finished.catch(() => {})),
                            );
                            await new Promise(requestAnimationFrame);
                        });
                        if (rendering === 'reduced')
                            expect(
                                await page.evaluate(
                                    () =>
                                        matchMedia('(prefers-reduced-transparency: reduce)')
                                            .matches,
                                ),
                            ).toBe(true);
                        const glass = await page.locator('.glass-sample').evaluateAll((elements) =>
                            elements.map((element) => ({
                                kind: element.className,
                                filter: getComputedStyle(element).backdropFilter,
                                background: getComputedStyle(element).backgroundColor,
                            })),
                        );
                        if (fallback)
                            expect(glass.every((item) => item.filter === 'none')).toBe(true);
                        else
                            expect(glass.every((item) => item.filter.includes('blur('))).toBe(true);
                        const contrast = await measureContrast(page);
                        expect(contrast).toHaveLength(32);
                        measurements.push({ backdrop, glass, contrast });
                        for (const item of contrast) {
                            if (item.minimum === 3)
                                expect(parseFloat(item.fontSize)).toBeGreaterThanOrEqual(24);
                            expect(
                                item.ratio,
                                `${accent}/${scheme}/${rendering}/${backdrop}: ${item.text} (${item.glass ?? 'surface'})`,
                            ).toBeGreaterThanOrEqual(item.minimum);
                        }
                        await expect(
                            page.getByRole('button', { name: '调整样例外观', exact: true }),
                        ).toBeVisible();
                        await expect(
                            page.getByRole('button', { name: '确认操作', exact: true }),
                        ).toHaveCount(5);
                        await expect(page.locator('.sample-actions .app-icon')).toHaveCount(2);
                        expect(
                            await page
                                .locator('.sample-actions .app-icon')
                                .evaluateAll((icons) =>
                                    icons.every(
                                        (icon) => icon.getAttribute('aria-hidden') === 'true',
                                    ),
                                ),
                        ).toBe(true);
                        if (backdrop === 'white') {
                            fonts = await platformFonts(page);
                            const serialized = JSON.stringify(fonts);
                            if (fallback) {
                                expect(blocked.length).toBeGreaterThan(0);
                                expect(serialized).not.toContain('"isCustomFont":true');
                            } else {
                                expect(JSON.stringify(fonts.interface)).toMatch(/Noto Sans SC/);
                                expect(JSON.stringify(fonts.reading)).toMatch(/Noto Serif SC/);
                                expect(JSON.stringify(fonts.latin)).toMatch(/Inter/);
                                expect(serialized).toContain('"isCustomFont":true');
                            }
                            await page.screenshot({
                                path: testInfo.outputPath('sample.png'),
                                fullPage: true,
                            });
                        }
                    }
                    expect(errors).toEqual([]);
                } finally {
                    const measurementPath = testInfo.outputPath('rendered-measurements.json');
                    writeFileSync(
                        measurementPath,
                        JSON.stringify(
                            {
                                source,
                                browser: browser.version(),
                                accent,
                                scheme,
                                rendering,
                                fontMode: fallback ? 'blocked' : 'self-hosted',
                                fonts,
                                blockedRequests: blocked.length,
                                measurements,
                            },
                            null,
                            2,
                        ),
                    );
                    await testInfo.attach('rendered-measurements.json', {
                        path: measurementPath,
                        contentType: 'application/json',
                    });
                    await session.detach();
                }
            });
        }
    }
}
