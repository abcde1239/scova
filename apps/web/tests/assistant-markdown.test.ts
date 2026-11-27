// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';

let server: ViteDevServer;
let markdown: Component;

beforeAll(async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    server = await createServer({
        root,
        configFile: false,
        plugins: [vue()],
        optimizeDeps: { noDiscovery: true, include: [] },
        resolve: { alias: { '@': resolve(root, 'src') } },
        server: { middlewareMode: true, watch: null, hmr: false, ws: false },
        appType: 'custom',
    });
    markdown = (await server.ssrLoadModule('/src/component/common/AssistantMarkdown.vue')).default;
});
afterAll(async () => server?.close());

async function render(text: string) {
    const html = await renderToString(createSSRApp({ render: () => h(markdown, { text }) }));
    return new DOMParser().parseFromString(html, 'text/html');
}

describe('project assistant Markdown', () => {
    it('keeps semantic lists, links, tables and source for unknown languages', async () => {
        const doc = await render(
            [
                '## 研究摘要',
                '',
                '- 第一项',
                '',
                '[来源](https://example.com/evidence)',
                '',
                '| 内容 | 结论 |',
                '| --- | --- |',
                '| A | B |',
                '',
                '```unknown-lang',
                '<i>仍是代码</i>',
                '```',
            ].join('\n'),
        );
        expect(doc.querySelector('h2')?.textContent).toContain('研究摘要');
        expect(doc.querySelector('ul li')?.textContent).toContain('第一项');
        expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/evidence');
        expect(doc.querySelector('table th')?.textContent).toContain('内容');
        expect(doc.querySelector('pre code')?.textContent).toContain('<i>仍是代码</i>');
    });

    it('renders HTML literally and drops dangerous links and remote images', async () => {
        const doc = await render(
            [
                '<img src="https://example.com/raw.png">',
                '',
                '[不可执行](javascript:alert(1)) [不可跳转](/api/v1/private)',
                '',
                '![研究插图](https://example.com/markdown.png)',
            ].join('\n'),
        );
        expect(doc.querySelector('img, a')).toBeNull();
        expect(doc.body.textContent).toContain('<img src=');
        expect(doc.body.textContent).toContain('研究插图');
    });

    it('falls back to escaped text when the render budget is exceeded', async () => {
        const doc = await render(`# 纯文本回退\n${'长'.repeat(12_001)}<b>原样</b>`);
        expect(doc.querySelector('h1, b')).toBeNull();
        expect(doc.body.textContent).toContain('# 纯文本回退');
        expect(doc.body.textContent).toContain('<b>原样</b>');
    });
});
