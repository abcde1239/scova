import { describe, expect, it } from 'vite-plus/test';
import { extractPage } from '../src/reader/extraction/extract.ts';

const extract = (body: string) =>
    extractPage(
        'https://fixture.example/content',
        {
            url: 'https://fixture.example/content',
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body,
        },
        1_000_000,
    );

describe('independent primary content and table edge regression', () => {
    it('preserves substantive workflow description pairs inside the primary document', () => {
        const page = extract(
            '<main><h1>Renew a public document</h1><p>Read the requirements before applying.</p><nav><h2>Sections</h2><dl><dt><a href="/eligibility">Check eligibility</a></dt><dd>Find out whether the document can be renewed and when to renew it.</dd><dt><a href="/documents">Prepare documents</a></dt><dd>Gather the required photos, identification and supporting documents.</dd></dl></nav></main>',
        );
        expect(page.text).toContain('Check eligibility');
        expect(page.text).toContain('Find out whether the document can be renewed');
        expect(page.text).toContain('Prepare documents');
        expect(page.text).toContain('Gather the required photos');
    });
    it('still removes menus and workflow-shaped links outside the primary document', () => {
        const workflow =
            '<dl><dt><a href="/one">UNRELATED-STEP-ONE</a></dt><dd>Unrelated first service description with enough characters.</dd><dt><a href="/two">UNRELATED-STEP-TWO</a></dt><dd>Unrelated second service description with enough characters.</dd></dl>';
        const page = extract(
            `<nav>${workflow}</nav><main><h1>Actual public notice</h1><p>PRIMARY-BODY: The public office is open until six.</p><header><nav>${workflow}</nav></header><aside><nav>${workflow}</nav></aside><nav hidden>${workflow}</nav><nav style="display:none">${workflow}</nav><nav><a href="/menu">SHORT-MENU-LINK</a></nav></main>`,
        );
        expect(page.text).toContain('PRIMARY-BODY');
        expect(page.text).not.toMatch(/UNRELATED-STEP|SHORT-MENU-LINK/);
    });
    it('requires actual adjacent term-description pairs and meaningful descriptions', () => {
        const page = extract(
            '<main><h1>Public notice</h1><p>PRIMARY-BODY: Follow the published conditions.</p><nav><dl><dt><a href="/one">UNPAIRED-MENU</a></dt><dt><a href="/two">SECOND-UNPAIRED-MENU</a></dt><dd>One long description cannot turn two unpaired menu terms into a workflow.</dd></dl></nav><nav><dl><dt><a href="/one">TINY-MENU-ONE</a></dt><dd>First</dd><dt><a href="/two">TINY-MENU-TWO</a></dt><dd>Second</dd></dl></nav></main>',
        );
        expect(page.text).toContain('PRIMARY-BODY');
        expect(page.text).not.toMatch(/UNPAIRED-MENU|TINY-MENU/);
    });
    it('keeps public SVG text labels without scripts, foreign HTML or path data', () => {
        const page = extract(
            '<main><h1>SQL diagram</h1><svg><path d="PRIVATE-PATH-DATA"/><text>SELECT <tspan>column</tspan></text><text>FROM table</text><script>EVIL-SCRIPT</script><foreignObject><div>FOREIGN-HTML</div></foreignObject></svg><svg aria-hidden="true"><text>HIDDEN-ICON</text></svg></main>',
        );
        expect(page.text).toContain('SELECT column\nFROM table');
        expect(page.text).not.toMatch(/EVIL-SCRIPT|FOREIGN-HTML|PRIVATE-PATH-DATA|HIDDEN-ICON/);
    });
    it('retains SVG labels when article extraction uses the lightweight fallback', () => {
        const page = extract(
            `<div><h2>Syntax explanation</h2><p>${'This language reference describes query syntax and conditions. '.repeat(8)}</p><div class="imgcontainer"><div><svg><text>WITH RECURSIVE</text><text>SELECT result-column</text><text>FROM table-or-subquery</text></svg></div></div><p>${'Each query may include an optional predicate and ordering clause. '.repeat(8)}</p></div>`,
        );
        expect(page.text).toContain('WITH RECURSIVE');
        expect(page.text).toContain('SELECT result-column');
        expect(page.text).toContain('FROM table-or-subquery');
    });
    it('keeps missing values in their original table columns', () => {
        const page = extract(
            '<main><h1>Inventory</h1><table><tr><th>Item</th><th>Price</th><th>Quantity</th></tr><tr><td>Basic</td><td></td><td>30</td></tr></table></main>',
        );
        expect(page.text).toContain('Item\tPrice\tQuantity\nBasic\t\t30');
    });
    it('retains a table selected by the lightweight Readability fallback', () => {
        const page = extract(
            '<div><p>Official inventory report with current available stock.</p><table><tr><th>Item</th><th>Price</th><th>Quantity</th></tr><tr><td>Basic</td><td></td><td>30</td></tr></table></div>',
        );
        expect(page.text).toContain('Item\tPrice\tQuantity\nBasic\t\t30');
    });
    it('retains row-spanning labels without shifting the next row left', () => {
        const page = extract(
            '<main><table><tr><th>Item</th><th>Region</th><th>Price</th></tr><tr><td rowspan="2">Basic</td><td>EU</td><td>10</td></tr><tr><td>US</td><td>12</td></tr></table></main>',
        );
        expect(page.text).toContain('Basic\tEU\t10\nBasic\tUS\t12');
    });
    it('retains group headers and child columns for column-spanning tables', () => {
        const page = extract(
            '<main><table><tr><th rowspan="2">Region</th><th colspan="2">Price</th></tr><tr><th>2025</th><th>2026</th></tr><tr><td>EU</td><td>10</td><td>12</td></tr></table></main>',
        );
        expect(page.text).toContain('Region\tPrice\tPrice\nRegion\t2025\t2026\nEU\t10\t12');
    });
    it('limits rowspan zero to the current row group', () => {
        const page = extract(
            '<main><table><tbody><tr><td rowspan="0">A</td><td>1</td></tr><tr><td>2</td></tr></tbody><tbody><tr><td>B</td><td>3</td></tr></tbody></table></main>',
        );
        expect(page.text).toContain('A\t1\nA\t2\nB\t3');
    });
    it('bounds expansion of malicious span declarations', () => {
        expect(() =>
            extract('<main><table><tr><td colspan="999999999">A</td></tr></table></main>'),
        ).toThrowError(expect.objectContaining({ code: 'extraction_failed' }));
    });
    it('does not multiply a long merged cell across the entire table', () => {
        const long = 'a'.repeat(1000);
        const page = extract(`<main><table><tr><td colspan="200">${long}</td></tr></table></main>`);
        expect(page.text.split(long)).toHaveLength(2);
        expect(page.text.length).toBeLessThan(20_000);
        expect(page.text).toContain('same cell as row 1, column 1');
    });
    it('retains source list values including reversed numbering', () => {
        expect(
            extract(
                '<main><ol start="10"><li>First</li><li value="20">Second</li><li>Third</li></ol></main>',
            ).text,
        ).toContain('10. First\n\n20. Second\n\n21. Third');
        expect(
            extract(
                '<main><ol reversed><li>First</li><li value="9">Second</li><li>Third</li></ol></main>',
            ).text,
        ).toContain('3. First\n\n9. Second\n\n8. Third');
    });
    it('prefers an actual article main over an earlier shallow preview', () => {
        const page = extract(
            '<main><p>Placeholder preview of the planned launch. Published terms follow below.</p></main><main><article><h1>Launch terms</h1><p>PRIMARY-FINAL-TERMS: all applications close on 15 November 2026.</p></article></main>',
        );
        expect(page.text).toContain('PRIMARY-FINAL-TERMS');
        expect(page.text).not.toContain('Placeholder preview');
    });
    it('ignores a primary region explicitly hidden with inline CSS', () => {
        const page = extract(
            '<main style="display:none"><h1>Old heading</h1><article>Wrong old body.</article></main><main><h1>Current heading</h1><p>Correct current body.</p></main>',
        );
        expect(page.text).toContain('Correct current body');
        expect(page.text).not.toContain('Wrong old body');
    });
    it('retains traditional content containers instead of choosing a long footer', () => {
        const page = extract(
            `<div id="Main"><h1>Forum topics</h1><table><tr><td></td><td>PRIMARY-TOPIC-ONE<br>by Alice</td><td>12 replies</td></tr></table><table><tr><td></td><td>PRIMARY-TOPIC-TWO<br>by Bob</td><td>2 replies</td></tr></table></div><footer>${'Long unrelated community footer. '.repeat(30)}</footer>`,
        );
        expect(page.text).toContain('PRIMARY-TOPIC-ONE');
        expect(page.text).toContain('PRIMARY-TOPIC-TWO');
        expect(page.text).toContain('Alice');
        expect(page.text).not.toContain('Long unrelated');
    });
    it('does not mistake a local div named content for the whole document', () => {
        const start =
            'INTRODUCTION-MARKER: The protocol introduces the normative contract and its scope. '.repeat(
                8,
            );
        const end =
            'FINAL-MARKER: Security and compatibility considerations apply to every preceding section. '.repeat(
                8,
            );
        const page = extract(
            `<h1>Protocol specification</h1><div id="introduction"><section><h2>Introduction</h2><p>${start}</p></section></div><div id="content"><section><h3>6.4 Content</h3><p>This is one small section about message content.</p></section></div><div id="security"><section><h2>Security</h2><p>${end}</p></section></div>`,
        );
        expect(page.text).toContain('INTRODUCTION-MARKER');
        expect(page.text).toContain('6.4 Content');
        expect(page.text).toContain('FINAL-MARKER');
    });
    it('does not treat an anchor or nested section id as a primary content container', () => {
        const page = extract(
            '<article><h1>Published report</h1><p>INTRO: Real report begins here.</p><section id="content"><h2>Small section</h2><p>Local content only.</p></section><p>TAIL: Real report ends here.</p></article>',
        );
        expect(page.text).toContain('INTRO: Real report');
        expect(page.text).toContain('TAIL: Real report');
    });
    it('preserves author and reply metadata in nested legacy layout tables', () => {
        const page = extract(
            '<table id="forumMain"><tr><td><table><tr><td><h1>Primary discussion</h1></td></tr></table></td></tr><tr><td><table><tr><td>by Alice · 2 hours ago</td></tr><tr><td>First reply with its complete condition.</td></tr><tr><td>by Bob · 1 hour ago</td></tr><tr><td>Second reply with the opposite condition.</td></tr></table></td></tr></table>',
        );
        expect(page.text).toContain('Primary discussion');
        expect(page.text).toContain('by Alice');
        expect(page.text).toContain('by Bob');
        expect(page.text.indexOf('Alice')).toBeLessThan(page.text.indexOf('First reply'));
        expect(page.text.indexOf('Bob')).toBeLessThan(page.text.indexOf('Second reply'));
    });
});
