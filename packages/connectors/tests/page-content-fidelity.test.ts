import { describe, expect, it } from 'vite-plus/test';
import { extractPage, pageFingerprint } from '../src/page-extraction.ts';

const extract = (body: string) =>
    extractPage(
        'https://example.com/page',
        {
            url: 'https://example.com/page',
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body,
        },
        1_000_000,
    );

describe('source content fidelity', () => {
    it('retains the primary article abstract even when references are much longer', () => {
        const page = extract(
            `<title>Research article</title><main><article><section><h2>Abstract</h2><p>Public abstract establishes the specific finding and its experimental limits.</p></section><section><h2>References</h2>${'<p>Reference entry with many authors and journal identifiers.</p>'.repeat(40)}</section></article></main>`,
        );
        expect(page.text).toContain('Public abstract establishes');
        expect(page.text.indexOf('Abstract')).toBeLessThan(page.text.indexOf('References'));
    });
    it('retains every product section rather than only the longest prose section', () => {
        const page = extract(
            `<title>Phones</title><nav>Unrelated navigation</nav><main><section><h1>Explore the lineup</h1><h2>Phone A</h2><p>$500</p><h2>Phone B</h2><p>$700</p></section><section><h2>Compare all models</h2><table><tr><th>Model</th><th>Battery</th></tr><tr><td>A</td><td>20 hours</td></tr></table></section><section><p>${'Accessories work well together. '.repeat(20)}</p></section></main>`,
        );
        expect(page.text).toContain('Phone A');
        expect(page.text).toContain('Phone B');
        expect(page.text).toContain('Compare all models');
        expect(page.text).not.toContain('Unrelated navigation');
    });
    it('retains document syntax and examples alongside descriptive prose', () => {
        const page = extract(
            `<div class="refentry"><h1>SELECT</h1><h2>Synopsis</h2><pre>SELECT column\nFROM table\nWHERE condition</pre><h2>Description</h2><p>${'Select retrieves data from the table. '.repeat(20)}</p></div>`,
        );
        expect(page.text).toContain('SELECT column\nFROM table\nWHERE condition');
        expect(page.text).toContain('Description');
    });
    it('retains code indentation and the boundary after a line comment', () => {
        const code = 'if ready:\n    publish()\n# outside the condition\ncleanup()';
        const page = extract(`<article><h1>Example</h1><pre>${code}</pre></article>`);
        expect(page.text).toContain(code);
        expect(page.contentHash).toBe(pageFingerprint(page.text));
    });
    it('does not normalize code tabs, blank lines or multiline string whitespace', () => {
        const code = '\t\tvalue = """first\n\n\nlast  \n"""\n\t\treturn value';
        const page = extract(`<article><pre>${code}</pre></article>`);
        expect(page.text).toContain(code);
    });
    it('preserves code when a paragraph-free page uses the lightweight fallback DOM', () => {
        const page = extract(
            '<div><p>Steps for configuring a useful project.</p><pre>first()\n# comment\nsecond()</pre></div>',
        );
        expect(page.text).toContain('first()\n# comment\nsecond()');
    });
    it('separates table cells and rows and preserves units', () => {
        const page = extract(
            '<article><h1>Plans</h1><table><tr><th>Plan</th><th>USD</th><th>Days</th></tr><tr><td>Basic</td><td>10</td><td>30</td></tr><tr><td>Pro</td><td>20</td><td>90</td></tr></table></article>',
        );
        expect(page.text).toContain('Plan\tUSD\tDays');
        expect(page.text).toContain('Basic\t10\t30');
        expect(page.text).toContain('Pro\t20\t90');
        expect(page.text).not.toContain('1030');
    });
    it('keeps list item boundaries and source ordering', () => {
        const page = extract(
            '<article><h1>Instructions</h1><ol start="3"><li>Disconnect power</li><li>Inspect the wiring</li></ol><p>Confirm the result.</p></article>',
        );
        expect(page.text).toContain('3. Disconnect power');
        expect(page.text).toContain('4. Inspect the wiring');
        expect(page.text.indexOf('Disconnect power')).toBeLessThan(
            page.text.indexOf('Inspect the wiring'),
        );
    });
    it('keeps scholarly aside footnotes while excluding navigation and unrelated sidebars', () => {
        const page = extract(
            '<main><h1>Study</h1><p>The method has an important condition.</p><aside>Unrelated advertising</aside><aside class="footnote-list"><aside role="doc-footnote">Only valid above freezing.</aside></aside></main>',
        );
        expect(page.text).toContain('Only valid above freezing.');
        expect(page.text).not.toContain('Unrelated advertising');
    });
    it('uses the actual document title and avoids duplicated MathML annotations', () => {
        const page = extract(
            '<title>响应式基础 | Vue.js</title><main><h1>响应式基础</h1><p>Formula: <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x_{duplicate}</annotation></semantics></math></p></main>',
        );
        expect(page.title).toBe('响应式基础 | Vue.js');
        expect(page.text).toContain('Formula: x');
        expect(page.text).not.toContain('x_{duplicate}');
    });
});
