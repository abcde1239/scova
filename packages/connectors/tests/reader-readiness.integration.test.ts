import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPageReader } from '../src/browser-reader.ts';
import { createSafeHttpClient } from '../src/http.ts';
import { ConnectorError, type PageReader } from '../src/types.ts';

const url = 'https://fixture.example/article';
const paragraph =
    'The library confirms winter opening dates, application conditions and the deadline for submitting reader requests. '.repeat(
        5,
    );
const article = `<article><h1>Published library notice</h1><p>${paragraph}</p><p>ACTUAL-NOTICE-END-2026</p></article>`;
const readers: PageReader[] = [];
afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.close?.() ?? Promise.resolve()));
});

function fixture(html: string, onResource?: () => void) {
    const transport = vi.fn(async (target: URL) => {
        if (target.pathname === '/app.js') onResource?.();
        return {
            status: 200,
            headers: {
                'content-type': `${target.pathname === '/app.js' ? 'application/javascript' : 'text/html'}; charset=utf-8`,
            },
            body:
                target.pathname === '/app.js'
                    ? `setTimeout(()=>{const main=document.getElementById('root');main.innerHTML=${JSON.stringify(article)};main.removeAttribute('aria-busy')},500)`
                    : html,
        };
    });
    const reader = createPageReader({
        http: createSafeHttpClient({
            resolve: async () => [{ address: '93.184.216.34', family: 4 }],
            transport,
        }),
        renderWaitMs: 600,
    });
    readers.push(reader);
    return { reader, transport };
}

describe('Reader primary readiness and public access scope', () => {
    it.each([
        `<main id="root" aria-busy="true"><article><p>SSR-PREVIEW-ONLY ${paragraph}</p></article></main>`,
        `<main id="root"><div>加载中，请稍候……</div><div>LEGAL-SHELL-ONLY ${paragraph}</div></main>`,
        `<main id="root"></main><section class="related"><article>UNREQUESTED-ARTICLE ${paragraph}</article></section>`,
    ])(
        'renders the requested primary body before accepting a preview or recommendation',
        async (html) => {
            const { reader, transport } = fixture(
                `<!doctype html>${html}<script src="/app.js"></script>`,
            );
            const page = await reader.read(url);
            expect(page.text).toContain('ACTUAL-NOTICE-END-2026');
            expect(page.text).not.toMatch(/SSR-PREVIEW-ONLY|LEGAL-SHELL-ONLY|UNREQUESTED-ARTICLE/);
            expect(page.collection).toEqual({
                version: 1,
                method: 'browser',
                complete: true,
                limitations: [],
            });
            expect(transport.mock.calls.some(([target]) => target.pathname === '/app.js')).toBe(
                true,
            );
        },
    );
    it('rejects long login terms instead of returning a successful page', async () => {
        const { reader, transport } = fixture(
            `<title>用户登录</title><main><form><input type="password"></form><p>${paragraph}</p></main><script src="/app.js"></script>`,
        );
        await expect(reader.read(url)).rejects.toMatchObject({ code: 'http', status: 403 });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('does not start application resources for an unrecoverable table expansion limit', async () => {
        const { reader, transport } = fixture(
            '<main><table><tr><td colspan="257">oversized table</td></tr></table></main><script src="/app.js"></script>',
        );
        await expect(reader.read(url)).rejects.toMatchObject({
            code: 'extraction_failed',
            message: '表格展开结构超过提取限制',
        });
        expect(transport.mock.calls.map(([target]) => target.pathname)).toEqual(['/article']);
    });
    it('preserves static public abstract acquisition limits', async () => {
        const { reader } = fixture(
            `<title>Published research abstract</title><main><article><h1>Research abstract</h1><p>${paragraph}</p></article><p>This is a preview of subscription content, access via your institution.</p></main>`,
        );
        const page = await reader.read(url);
        expect(page.text).toContain('winter opening dates');
        expect(page.collection).toEqual({
            version: 1,
            method: 'html',
            complete: false,
            limitations: ['content_restricted'],
        });
    });
    it('merges rendered content limits with browser collection status', async () => {
        const { reader } = fixture(
            '<main id="root">Loading...</main><script>setTimeout(()=>{document.getElementById("root").innerHTML=' +
                JSON.stringify(article + '<a rel="next" href="/next">下一页</a>') +
                '},50)</script>',
        );
        const page = await reader.read(url);
        expect(page.text).toContain('ACTUAL-NOTICE-END-2026');
        expect(page.collection).toMatchObject({ method: 'browser', complete: false });
        expect(page.collection?.limitations).toContain('interaction_required');
    });
    it('collects nested open shadow content in the actual browser', async () => {
        const script = `const first=document.getElementById('root').attachShadow({mode:'open'});first.innerHTML='<section></section>';first.querySelector('section').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(article)}`;
        const { reader } = fixture(`<main id="root"></main><script>${script}</script>`);
        const page = await reader.read(url);
        expect(page.text).toContain('ACTUAL-NOTICE-END-2026');
        expect(page.collection).toMatchObject({ method: 'browser', complete: true });
    });
    it('rejects an oversized open shadow tree before serializing it', async () => {
        const { reader } = fixture(
            '<main id="root"></main><script>document.getElementById("root").attachShadow({mode:"open"}).innerHTML="<br>".repeat(20001)</script>',
        );
        await expect(reader.read(url)).rejects.toMatchObject({ code: 'extraction_failed' });
    });
    it('renders a primary chart instead of returning only static source/license text', async () => {
        const script = `setTimeout(()=>{document.getElementById('root').innerHTML=${JSON.stringify(article + '<table><tr><th>Region</th><th>Population</th></tr><tr><td>Exampleland</td><td>1234567</td></tr></table>')}},50)`;
        const { reader } = fixture(
            `<main id="root"><h1>Population</h1><p>${paragraph}</p><div class="d3-chart spinning"></div><p>License: CC BY</p></main><script>${script}</script>`,
        );
        const page = await reader.read(url);
        expect(page.text).toContain('Exampleland\t1234567');
        expect(page.collection).toMatchObject({ method: 'browser', complete: true });
    });
    it('retains useful metadata as partial when the primary chart never resolves', async () => {
        const { reader } = fixture(
            `<main id="root"><h1>Population</h1><p>${paragraph}</p><div class="d3-chart spinning"></div><p>License: CC BY</p></main>`,
        );
        const page = await reader.read(url);
        expect(page.text).toContain('License: CC BY');
        expect(page.collection).toMatchObject({ method: 'browser', complete: false });
        expect(page.collection?.limitations).toContain('render_timeout');
    });
    it('retains verified static partial content without starting a browser when no render budget remains', async () => {
        const { reader, transport } = fixture(
            `<main><h1>Population</h1><p>${paragraph}</p><div class="d3-chart spinning"></div></main><script src="/app.js"></script>`,
        );
        const page = await reader.read(url, { timeoutMs: 2500 });
        expect(page.text).toContain('winter opening dates');
        expect(page.collection).toEqual({
            version: 1,
            method: 'html',
            complete: false,
            limitations: ['render_timeout'],
        });
        expect(transport.mock.calls.map(([target]) => target.pathname)).toEqual(['/article']);
    });
    it('does not convert a caller abort into a retained partial success', async () => {
        const controller = new AbortController();
        const { reader } = fixture(
            `<main><h1>Population</h1><p>${paragraph}</p><div class="d3-chart spinning"></div></main><script src="/app.js"></script>`,
            () => controller.abort(),
        );
        await expect(reader.read(url, { signal: controller.signal })).rejects.toMatchObject({
            code: 'aborted',
        });
    });
    it('ends optional rendering inside the outer deadline and keeps the verified partial body', async () => {
        const { reader } = fixture(
            `<main id="root"><p>${paragraph}</p><div class="d3-chart spinning"></div></main><script>document.getElementById('root').setAttribute('aria-busy','true')</script>`,
        );
        const page = await reader.read(url, { timeoutMs: 7000 });
        expect(page.text).toContain('winter opening dates');
        expect(page.collection).toMatchObject({ method: 'html', complete: false });
        expect(page.collection?.limitations).toContain('render_timeout');
    });
    it('waits for a failed dynamic fee placeholder to resolve before certifying completeness', async () => {
        const { reader } = fixture(
            `<main><h1>Service fees</h1><p>${paragraph}</p><span id="fee" data-json-replace="#[fee]/service/en">[Error loading fee. Check the fee list.]</span></main><script>setTimeout(()=>document.getElementById('fee').textContent='$120',900)</script>`,
        );
        const page = await reader.read(url);
        expect(page.text).toContain('$120');
        expect(page.text).not.toContain('Error loading fee');
        expect(page.collection).toMatchObject({ method: 'browser', complete: true });
    });
    it('retains service information as partial when its dynamic fee never resolves', async () => {
        const { reader } = fixture(
            `<main><h1>Service fees</h1><p>${paragraph}</p><span data-json-replace="#[fee]/service/en">[Error loading fee. Check the fee list.]</span></main>`,
        );
        const page = await reader.read(url);
        expect(page.text).toContain('winter opening dates');
        expect(page.collection?.complete).toBe(false);
        expect(page.collection?.limitations).toContain('render_timeout');
    });
    it('does not convert a budget callback rejection into partial success', async () => {
        const { reader, transport } = fixture(
            `<main><p>${paragraph}</p><div class="d3-chart spinning"></div></main>`,
        );
        const error = new ConnectorError('budget_exceeded', 'No read reservations remain');
        await expect(
            reader.read(url, {
                beforeAttempt: () => {
                    throw error;
                },
            }),
        ).rejects.toBe(error);
        expect(transport).not.toHaveBeenCalled();
    });
    it('does not downgrade a blocked browser navigation using earlier static partial content', async () => {
        const { reader } = fixture(
            `<main><p>${paragraph}</p><div class="d3-chart spinning"></div></main><script>location.href='https://other.example/private'</script>`,
        );
        await expect(reader.read(url)).rejects.toMatchObject({ code: 'unsafe_url' });
    });
});
