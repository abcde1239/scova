// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { ArtifactDocument, Report } from '@scova/models';
import { reportTableLayout } from '@/utils/report/widths';
import {
    documentSectionNumbers,
    groupRuns,
    splitStructuredDocument,
    tabularList,
    visibleFields,
} from '@/utils/report/artifacts';

type Content = NonNullable<NonNullable<Report['coverage']['artifacts']>[number]['content']>;
type List = NonNullable<Content['list']>;
type Field = List['entries'][number]['fields'][number];

let server: ViteDevServer;
let documentView: Component;
let structuredView: Component;

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
    documentView = (await server.ssrLoadModule('/src/component/reports/ReportDocument.vue'))
        .default;
    structuredView = (
        await server.ssrLoadModule('/src/component/reports/ReportStructuredContent.vue')
    ).default;
});
afterAll(async () => server?.close());

const claimTexts = [
    '甲更适合小团队。部署只需一个进程，运维成本低。',
    '乙在大规模数据下更稳定',
    '两者都开源。',
    '价格资料缺少统一口径。',
];
function report(conditions: Record<number, string> = {}): Report {
    return {
        claims: claimTexts.map((text, index) => ({
            id: `c${index}`,
            kind: 'inference',
            text,
            confidenceLabel: '',
        })),
        evidence: [],
        publishedAt: '2026-11-12T08:00:00Z',
        coverage: {
            searchedQueries: ['甲 部署', '乙 规模'],
            reportValue: {
                version: 1,
                timeless: true,
                questions: [],
                selections: claimTexts.map((_text, claimIndex) => ({
                    claimIndex,
                    questionIds: ['q0'],
                    placement: 'main',
                    reason: '',
                    basis: 'model_assessment',
                    timeScope: 'unknown',
                    assessment: conditions[claimIndex]
                        ? {
                              relevance: 'direct',
                              support: 'direct',
                              role: 'answer',
                              sourceRelation: 'original',
                              reason: '',
                              conditions: conditions[claimIndex]!,
                              gap: '',
                          }
                        : undefined,
                })),
            },
        },
    } as unknown as Report;
}
const doc = (...roles: [ArtifactDocument['sections'][number]['role'], number[]][]) =>
    ({
        version: 1,
        sections: roles.map(([role, claimIndexes], index) => ({
            id: `s${index}`,
            title: `标题${index}`,
            role,
            claimIndexes,
        })),
    }) satisfies ArtifactDocument;
async function render(component: Component, props: Record<string, unknown>) {
    const html = await renderToString(createSSRApp({ render: () => h(component, props) }));
    return new DOMParser().parseFromString(html, 'text/html');
}
const field = (id: string, label: string, text: string, status: Field['status'] = 'supported') =>
    ({
        id,
        label,
        text: status === 'unknown' ? '' : text,
        claimIndexes: status === 'unknown' ? [] : [0],
        status,
        gap: status === 'supported' ? '' : '来源未提供',
    }) satisfies Field;

describe('layout helpers', () => {
    it('numbers research chapters after the abstract only', () => {
        const outline = doc(
            ['overview', [0]],
            ['key_findings', [1]],
            ['analysis', [2]],
            ['limitations', [3]],
        );
        expect([...documentSectionNumbers(outline, 'research_report')]).toEqual([
            ['s2', 1],
            ['s3', 2],
        ]);
        expect(documentSectionNumbers(outline, 'brief').size).toBe(0);
    });
    it('splits a structured outline into scope above and synthesis below', () => {
        const split = splitStructuredDocument(doc(['overview', [2]], ['key_findings', [3]]));
        expect(split.lead?.sections.map((s) => s.role)).toEqual(['overview']);
        expect(split.tail?.sections.map((s) => s.role)).toEqual(['key_findings']);
        expect(splitStructuredDocument(doc(['key_findings', [3]])).lead).toBeUndefined();
        expect(splitStructuredDocument(undefined)).toEqual({ lead: undefined, tail: undefined });
    });
    it('uses a table only for shared, short and few fields', () => {
        const entry = (name: string, fields: Field[]) => ({ id: name, name, fields });
        const shared: List = {
            entries: [
                entry('甲', [field('a1', '许可', 'MIT'), field('a2', '版本', '2.0')]),
                entry('乙', [
                    field('b1', '许可', 'Apache-2.0'),
                    field('b2', '版本', '', 'unknown'),
                ]),
            ],
        };
        expect(tabularList(shared)).toEqual(['许可', '版本']);
        const mismatched = structuredClone(shared);
        mismatched.entries[1]!.fields[1]!.label = '发布日期';
        expect(tabularList(mismatched)).toBeUndefined();
        const long = structuredClone(shared);
        long.entries[0]!.fields[0]!.text = '长'.repeat(41);
        expect(tabularList(long)).toBeUndefined();
        const wide = {
            entries: [
                entry(
                    '甲',
                    Array.from({ length: 7 }, (_v, i) => field(`f${i}`, `字段${i}`, '值')),
                ),
            ],
        };
        expect(tabularList(wide)).toBeUndefined();
        expect(tabularList({ entries: [] })).toBeUndefined();
    });
    it('hides a field that only repeats the entry name but never empties an entry', () => {
        const fields = [field('n', '名称', '甲'), field('l', '许可', 'MIT')];
        expect(visibleFields({ id: 'x', name: '甲', fields }).map((f) => f.id)).toEqual(['l']);
        expect(visibleFields({ id: 'x', name: '甲', fields: [fields[0]!] })).toHaveLength(1);
    });
    it('groups consecutive items and keeps ungrouped runs unnamed', () => {
        const runs = groupRuns([{ group: '能力' }, { group: '能力' }, {}, { group: '成本' }]);
        expect(runs.map((run) => [run.group, run.items.length])).toEqual([
            ['能力', 2],
            ['', 1],
            ['成本', 1],
        ]);
    });
});

describe('report document layouts', () => {
    it('brief: conclusion card, numbered findings with emphasized lead sentence, caution box', async () => {
        const page = await render(documentView, {
            report: report(),
            format: 'brief',
            document: doc(['overview', [2]], ['key_findings', [0, 1]], ['limitations', [3]]),
        });
        expect(page.querySelector('.document-lead')).not.toBeNull();
        expect(page.querySelectorAll('ol.finding-list > li')).toHaveLength(2);
        const leads = [...page.querySelectorAll('.claim-lead')].map((node) => node.textContent);
        // The second finding has no sentence terminator, so nothing is emphasized.
        expect(leads).toEqual(['甲更适合小团队。']);
        expect(page.querySelector('ol.finding-list')?.textContent).toContain(
            '甲更适合小团队。部署只需一个进程，运维成本低。',
        );
        expect(page.querySelector('.document-caution')).not.toBeNull();
        expect(page.querySelector('.document-method')).toBeNull();
    });
    it('research report: abstract box with main conclusions, numbered chapters, metadata method', async () => {
        const page = await render(documentView, {
            report: report(),
            format: 'research_report',
            document: doc(
                ['overview', [0]],
                ['key_findings', [1]],
                ['analysis', [2]],
                ['limitations', [3]],
            ),
        });
        const abstract = page.querySelector('.document-abstract')!;
        expect(abstract.querySelector('#document-s1')?.textContent?.trim()).toBe('标题1');
        expect(abstract.textContent).toContain('乙在大规模数据下更稳定');
        expect(
            [...page.querySelectorAll('.section-number')].map((node) => node.textContent),
        ).toEqual(['1', '2']);
        expect(page.querySelector('.claim-lead')).toBeNull();
        const method = page.querySelector('.document-method')!.textContent!;
        expect(method).toContain('2 次');
        expect(method).toContain('0 个网页');
        expect(method).toContain('2026-11-12');
    });
    it('keeps conditions and gaps beside findings folded into the research abstract', async () => {
        const saved = report({ 1: '仅适用于单机部署' });
        saved.coverage.reportValue!.selections[1]!.assessment!.gap = '集群部署尚无资料';
        const page = await render(documentView, {
            report: saved,
            format: 'research_report',
            document: doc(['overview', [0]], ['key_findings', [1]]),
        });
        const findings = page.querySelector('.document-abstract .summary-findings')!;
        expect(findings.querySelector('.document-condition')?.textContent).toContain(
            '仅适用于单机部署',
        );
        expect(findings.querySelector('.document-gap')?.textContent).toContain('集群部署尚无资料');
        expect(findings.closest('details')).toBeNull();
    });
});

describe('structured content layouts', () => {
    it('gives a long column more room while keeping dimensions narrow and saved text intact', async () => {
        const longText =
            '长段落需要充足的阅读宽度，同时保留完整条件与例外。'.repeat(30) +
            '\n\n第二段保留原始分段。';
        const content: Content = {
            version: 1,
            comparison: {
                objects: [
                    { id: 'a', name: '短答案' },
                    { id: 'b', name: '长答案' },
                ],
                dimensions: [{ id: 'd', label: '机制' }],
                cells: [
                    { objectId: 'a', dimensionId: 'd', ...field('a', '', '短回答') },
                    { objectId: 'b', dimensionId: 'd', ...field('b', '', longText) },
                ],
            },
        };
        const before = structuredClone(content);
        const page = await render(structuredView, {
            report: report(),
            content,
            format: 'comparison',
        });
        const columns = [...page.querySelectorAll('col')].map((col) => parseFloat(col.style.width));
        expect(columns[2]).toBeGreaterThan(columns[1]!);
        expect(columns[0]).toBeLessThan(columns[1]!);
        expect(page.querySelectorAll('td')[1]!.textContent).toContain('第二段保留原始分段。');
        expect(
            page.querySelectorAll('td')[1]!.querySelectorAll('.structured-paragraph'),
        ).toHaveLength(2);
        expect(content).toEqual(before);
    });

    it('keeps many columns locally scrollable with bounded widths for long unbroken text', () => {
        const result = reportTableLayout(
            ['长维度'.repeat(50)],
            Array.from({ length: 12 }, () => ['https://example.com/' + 'x'.repeat(3000)]),
        );
        expect(result.widths.every((width) => width >= 14 && width <= 26)).toBe(true);
        expect(result.labelWidth).toBeLessThan(Math.min(...result.widths));
        expect(result.minWidth).toBeGreaterThan(12 * 14);
    });

    it('uses wider reading cards for long list fields without cutting the saved answer', async () => {
        const text = '完整说明适用范围、实现细节及必要条件。'.repeat(30);
        const content: Content = {
            version: 1,
            list: { entries: [{ id: 'a', name: '长文对象', fields: [field('f', '机制', text)] }] },
        };
        const page = await render(structuredView, { report: report(), content, format: 'list' });
        expect(page.querySelector('.list-table')).toBeNull();
        expect(
            page.querySelector<HTMLElement>('.object-list')!.style.gridTemplateColumns,
        ).toContain('30rem');
        expect(page.querySelector('.object-field dd')!.textContent).toContain(text);
    });
    const matrix = (group = true): Content => ({
        version: 1,
        comparison: {
            objects: [
                { id: 'o0', name: '甲' },
                { id: 'o1', name: '乙' },
            ],
            dimensions: [
                { id: 'd0', label: '许可', ...(group ? { group: '基础信息' } : {}) },
                { id: 'd1', label: '价格（元/月）', ...(group ? { group: '成本' } : {}) },
            ],
            cells: [
                { objectId: 'o0', dimensionId: 'd0', ...field('x', '', '两者都开源。') },
                { objectId: 'o1', dimensionId: 'd0', ...field('x', '', '两者都开源。') },
                { objectId: 'o0', dimensionId: 'd1', ...field('x', '', '', 'unknown') },
                { objectId: 'o1', dimensionId: 'd1', ...field('x', '', '两者都开源。', 'partial') },
            ].map(({ id: _id, label: _label, ...cell }) => cell),
        },
    });
    it('comparison: grouped rows, short cells, numbered notes and legend', async () => {
        const content = matrix();
        content.comparison!.cells[0]!.claimIndexes = [2];
        const page = await render(structuredView, {
            report: report({ 2: '仅限社区版' }),
            content,
            format: 'comparison',
        });
        expect(
            [...page.querySelectorAll('.group-row th')].map((n) => n.textContent?.trim()),
        ).toEqual(['基础信息', '成本']);
        expect(page.querySelector('thead th')?.textContent?.trim()).toBe('维度');
        expect(page.querySelectorAll('.value-tag')).toHaveLength(2);
        const notes = page.querySelector('.structured-notes')!.textContent!;
        expect(notes).toContain('仅限社区版');
        expect(notes).toContain('来源未提供');
        expect(notes).toContain('不等于“无”或“不支持”');
        // The same note text is numbered once and reused by every cell that needs it.
        expect(page.querySelectorAll('.structured-notes li')).toHaveLength(2);
        expect(page.querySelector('.structured-condition')).toBeNull();
    });
    it('comparison without groups renders no group rows and no legend when all supported', async () => {
        const content = matrix(false);
        for (const cell of content.comparison!.cells) Object.assign(cell, field('x', '', 'MIT'));
        const page = await render(structuredView, {
            report: report(),
            content,
            format: 'comparison',
        });
        expect(page.querySelector('.group-row')).toBeNull();
        expect(page.querySelector('.structured-notes')).toBeNull();
    });
    it('list: table plus narrow-screen cards when fields are shared, cards only otherwise', async () => {
        const tabular: Content = {
            version: 1,
            list: {
                entries: [
                    {
                        id: 'e0',
                        name: '甲',
                        group: '开源',
                        fields: [field('a', '许可', 'MIT'), field('b', '名称', '甲')],
                    },
                    {
                        id: 'e1',
                        name: '乙',
                        group: '开源',
                        fields: [field('c', '许可', 'Apache-2.0'), field('d', '名称', '乙')],
                    },
                ],
            },
        };
        const page = await render(structuredView, {
            report: report(),
            content: tabular,
            format: 'list',
        });
        expect(
            [...page.querySelectorAll('.list-table thead th')].map((n) => n.textContent?.trim()),
        ).toEqual(['条目', '许可']);
        expect(page.querySelectorAll('.list-table tbody tr:not(.group-row)')).toHaveLength(2);
        expect(page.querySelector('.list-table .group-row')?.textContent?.trim()).toBe('开源');
        expect(page.querySelectorAll('.object-card')).toHaveLength(2);
        const long = structuredClone(tabular);
        long.list!.entries[0]!.fields[0]!.text = '长'.repeat(50);
        const cards = await render(structuredView, {
            report: report(),
            content: long,
            format: 'list',
        });
        expect(cards.querySelector('.list-table')).toBeNull();
        expect(cards.querySelectorAll('.object-card')).toHaveLength(2);
    });
});
