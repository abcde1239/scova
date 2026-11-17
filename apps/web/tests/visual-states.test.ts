// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';

let server: ViteDevServer;
let panel: Component;
let filters: Component;

async function render(component: Component, props: Record<string, unknown>, slots = {}) {
    const html = await renderToString(createSSRApp({ render: () => h(component, props, slots) }));
    return new DOMParser().parseFromString(html, 'text/html');
}

beforeAll(async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    server = await createServer({
        configFile: false,
        root,
        plugins: [vue()],
        optimizeDeps: { noDiscovery: true, include: [] },
        resolve: { alias: { '@': resolve(root, 'src') } },
        server: { middlewareMode: true, watch: null, hmr: false },
        appType: 'custom',
    });
    panel = (await server.ssrLoadModule('/src/components/common/StatePanel.vue')).default;
    filters = (await server.ssrLoadModule('/src/components/tasks/TaskFilters.vue')).default;
});
afterAll(async () => server?.close());

describe('state panel empty state', () => {
    it('renders icon and next-step action while keeping the status text unchanged', async () => {
        const doc = await render(
            panel,
            { state: 'empty', message: '暂无报告', icon: 'inbox' },
            { action: () => h('a', { href: '/tasks' }, '查看任务') },
        );
        const section = doc.querySelector('.state-panel')!;
        expect(section.classList.contains('state-panel--empty')).toBe(true);
        expect(doc.querySelector('[role="status"]')?.textContent?.trim()).toBe('暂无报告');
        expect(doc.querySelector('.state-panel-icon')).not.toBeNull();
        expect(doc.querySelector('.state-panel-action a')?.textContent).toBe('查看任务');
    });

    it('omits icon and action when not provided', async () => {
        const doc = await render(panel, { state: 'empty' });
        expect(doc.querySelector('[role="status"]')?.textContent?.trim()).toBe('暂无内容');
        expect(doc.querySelector('.state-panel-icon')).toBeNull();
        expect(doc.querySelector('.state-panel-action')).toBeNull();
    });

    it('never shows empty decorations in loading or error states', async () => {
        for (const state of ['loading', 'error'] as const) {
            const doc = await render(
                panel,
                { state, icon: 'inbox' },
                { action: () => h('a', { href: '/tasks' }, '查看任务') },
            );
            expect(doc.querySelector('.state-panel--empty')).toBeNull();
            expect(doc.querySelector('.state-panel-icon')).toBeNull();
            expect(doc.querySelector('.state-panel-action')).toBeNull();
        }
    });
});

describe('state panel alert variant', () => {
    it('styles errors as an alert with a primary retry button', async () => {
        const doc = await render(panel, {
            state: 'error',
            message: '服务不可达',
            retryable: true,
            alert: true,
        });
        const section = doc.querySelector('.state-panel')!;
        expect(section.classList.contains('state-panel--alert')).toBe(true);
        expect(section.classList.contains('state-panel--centered')).toBe(false);
        expect(doc.querySelector('[role="status"]')?.textContent).toContain('服务不可达');
        expect(doc.querySelector('button')?.className).toContain('n-button--primary-type');
    });

    it('keeps the loading state free of alert styling', async () => {
        const doc = await render(panel, { state: 'loading', retryable: true, alert: true });
        expect(doc.querySelector('.state-panel--alert')).toBeNull();
        expect(doc.querySelector('button')?.getAttribute('aria-busy')).toBe('true');
    });

    it('uses a default retry button without the alert flag', async () => {
        const doc = await render(panel, { state: 'error', retryable: true });
        expect(doc.querySelector('.state-panel--alert')).toBeNull();
        expect(doc.querySelector('button')?.className).not.toContain('n-button--primary-type');
    });
});

describe('segmented task filters', () => {
    it('marks exactly the current filter as selected and checked', async () => {
        const doc = await render(filters, { value: 'paused' });
        const labels = [...doc.querySelectorAll('label')];
        expect(labels.length).toBeGreaterThan(1);
        const selected = labels.filter((label) => label.classList.contains('selected'));
        expect(selected).toHaveLength(1);
        expect(selected[0]!.textContent).toContain('暂停');
        const checked = [...doc.querySelectorAll('input[type="radio"]')].filter((input) =>
            input.hasAttribute('checked'),
        );
        expect(checked).toHaveLength(1);
        expect(doc.querySelector('fieldset')?.classList.contains('segmented-track')).toBe(true);
    });

    it('keeps native radios in the accessibility tree', async () => {
        const doc = await render(filters, { value: 'active' });
        for (const input of doc.querySelectorAll('input[type="radio"]')) {
            expect(input.getAttribute('aria-hidden')).toBeNull();
            expect(input.hasAttribute('hidden')).toBe(false);
        }
    });
});
