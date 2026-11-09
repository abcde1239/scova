// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ReportSchema, parseContract, type Report, type SessionResponse } from '@scova/models';
import type { SessionLifecycle } from '@/api/session';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const formats = ['brief', 'list', 'comparison', 'research_report'] as const;
const kinds = [
    'baseline',
    'new',
    'changed',
    'duplicate',
    'duplicate_candidate',
    'non_material',
    'uncertain',
] as const;
function fixture(): Report {
    const evidence = (n: number) => ({
        id: id(n),
        sourceId: id(100),
        snapshotId: id(n + 200),
        title: `来源 ${n}`,
        url: `https://example.test/saved/${n}`,
        quote: `  保存原文 ${n}\n<script>字面文本</script>  `,
        location: `第 ${n} 段`,
        observedAt: '2026-10-31T01:00:00Z',
    });
    return parseContract(ReportSchema, {
        id: id(1),
        runId: id(2),
        taskId: id(3),
        taskVersionId: id(4),
        baselineRunId: id(5),
        schemaVersion: 1,
        title: '四形式同一报告 <script>字面标题</script>',
        summary: '  原始概述\n<b>普通文字</b>  ',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['保存的查询'],
            gaps: ['原始覆盖缺口'],
            exhausted: ['pages'],
        },
        limitations: ['原始限制'],
        claims: [
            {
                id: id(10),
                kind: 'inference',
                text: '相同结论',
                confidenceLabel: '推断有限',
                evidenceIds: [id(21)],
            },
            {
                id: id(11),
                kind: 'fact',
                text: '  原文事实\n<em>字面文本</em>  ',
                confidenceLabel: '逐字支持',
                evidenceIds: [id(21), id(20)],
            },
            {
                id: id(12),
                kind: 'insufficient',
                text: '尚不能下结论',
                confidenceLabel: '不足',
                evidenceIds: [],
            },
            {
                id: id(13),
                kind: 'conflict',
                text: '冲突未解决',
                confidenceLabel: '保留冲突',
                evidenceIds: [id(20)],
            },
            {
                id: id(14),
                kind: 'inference',
                text: '相同结论',
                confidenceLabel: '同文不同ID',
                evidenceIds: [id(20)],
            },
        ],
        // 22 is change-only; 23 is completely unreferenced and still belongs in every appendix.
        evidence: [evidence(21), evidence(23), evidence(20), evidence(22)],
        changes: kinds.map((kind, index) => ({
            id: id(30 + index),
            sourceId: id(100),
            kind,
            factKey: `原始维度 ${index}`,
            oldValue: ['baseline', 'new'].includes(kind) ? null : '  旧值\n<em>字面文本</em>  ',
            newValue: kind === 'uncertain' ? null : '  新值\n第二行  ',
            oldEvidenceIds: ['baseline', 'new', 'non_material'].includes(kind)
                ? []
                : [id(22), id(20)],
            newEvidenceIds: kind === 'uncertain' ? [] : [id(21), id(22)],
            important: kind === 'changed',
            reason: `  原始原因 ${index}\n<b>普通文字</b>  `,
        })),
        publishedAt: '2026-10-31T02:00:00Z',
    });
}
const account: SessionResponse = {
    user: {
        id: id(900),
        email: 'formats@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'test-only',
};

describe('four actual report SFCs preserve one immutable saved report', () => {
    let server: ViteDevServer;
    const components = {} as Record<Report['format'], Component>;
    let detail: Component;
    let sessionModule: typeof import('@/api/session');
    let reportModule: typeof import('@/api/reports');
    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
            plugins: [vue()],
            optimizeDeps: { noDiscovery: true, include: [] },
            resolve: { alias: { '@': resolve(dirname(fileURLToPath(import.meta.url)), '../src') } },
            server: { middlewareMode: true, watch: null, hmr: false },
            appType: 'custom',
        });
        for (const [format, name] of Object.entries({
            brief: 'ReportBrief',
            list: 'TopicListReport',
            comparison: 'ComparisonReport',
            research_report: 'ResearchReport',
        }))
            components[format as Report['format']] = (
                await server.ssrLoadModule(`/src/components/reports/${name}.vue`)
            ).default as Component;
        detail = (await server.ssrLoadModule('/src/views/ReportDetailView.vue'))
            .default as Component;
        sessionModule = (await server.ssrLoadModule('/src/api/session.ts')) as typeof sessionModule;
        reportModule = (await server.ssrLoadModule('/src/api/reports.ts')) as typeof reportModule;
    }, 60000);
    afterAll(async () => server?.close());
    async function render(format: Report['format'], report: Report) {
        const output = await renderToString(
            createSSRApp({ render: () => h(components[format], { report }) }).use(createPinia()),
        );
        return new DOMParser().parseFromString(output, 'text/html');
    }
    function text(node: ParentNode, selector: string) {
        return node.querySelector(selector)?.textContent ?? '';
    }
    function evidenceQuotes(node: ParentNode, selector: string) {
        return [...node.querySelectorAll(selector)].map((entry) => entry.textContent);
    }
    function quote(report: Report, evidenceId: string) {
        return report.evidence.find((entry) => entry.id === evidenceId)!.quote;
    }

    it.each(formats)(
        '%s presents question answers, preserves conditions and separates reference clues',
        async (format) => {
            const report = fixture();
            const assessment = {
                relevance: 'direct',
                support: 'partial',
                role: 'answer',
                sourceRelation: 'unknown',
                reason: '正文部分支持',
                conditions: '仅限申请阶段',
                gap: '审批条件未知',
            } as const;
            report.coverage.reportValue = {
                version: 1,
                questions: [
                    {
                        id: 'q0',
                        text: '核心问题 <script>inert()</script>',
                        priority: 'core',
                        status: 'provisional',
                        claimIndexes: [1],
                        gap: '审批条件未知',
                    },
                    {
                        id: 'q1',
                        text: '补充问题',
                        priority: 'supporting',
                        status: 'unresolved',
                        claimIndexes: [],
                        gap: '尚无直接回答',
                    },
                ],
                selections: report.claims.map((_, index) => ({
                    claimIndex: index,
                    questionIds: index === 1 ? ['q0'] : [],
                    placement: index === 1 ? 'main' : index === 4 ? 'omitted' : 'reference',
                    reason: '报告选择说明',
                    basis: index === 1 ? 'model_assessment' : 'unassessed',
                    timeScope: 'unknown',
                    ...(index === 1 ? { assessment } : {}),
                })),
            };
            const document = await render(format, parseContract(ReportSchema, report));
            expect(text(document, '.report-delivery')).toContain('核心问题已回答');
            expect(text(document, '.report-delivery')).toContain('1/2');
            expect(text(document, '.answers')).toContain('主要结论');
            expect(text(document, '.answer')).toContain('仅限申请阶段');
            expect(document.querySelector('#question-q1')?.textContent).toContain('尚无直接回答');
            expect(document.querySelectorAll('.references .claim')).toHaveLength(3);
            expect(document.getElementById(`claim-${id(14)}`)).toBeNull();
            expect(document.querySelectorAll('.answers script')).toHaveLength(0);
            const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
            expect(new Set(ids).size).toBe(ids.length);
        },
    );

    it.each(formats)(
        '%s groups source viewpoints without losing citation ownership or shared-answer anchors',
        async (format) => {
            const report = fixture();
            report.evidence.find((entry) => entry.id === id(21))!.sourceId = id(101);
            report.claims[0]!.evidenceIds = [id(20)];
            report.claims[1]!.evidenceIds = [id(21)];
            report.claims[3]!.evidenceIds = [id(20), id(21)];
            report.claims.push({
                ...report.claims[4]!,
                id: id(15),
                text: '同一来源在另一问题的不同观点',
            });
            report.coverage.reportValue = {
                version: 1,
                questions: [
                    {
                        id: 'q0',
                        text: '核心问题',
                        priority: 'core',
                        status: 'provisional',
                        gap: '',
                        claimIndexes: [0, 1, 3, 4],
                    },
                    {
                        id: 'q1',
                        text: '补充问题',
                        priority: 'supporting',
                        status: 'provisional',
                        gap: '',
                        claimIndexes: [0, 5],
                    },
                ],
                selections: report.claims.map((_, claimIndex) => ({
                    claimIndex,
                    questionIds:
                        claimIndex === 0
                            ? ['q0', 'q1']
                            : claimIndex === 2
                              ? []
                              : claimIndex === 5
                                ? ['q1']
                                : ['q0'],
                    placement: claimIndex === 2 ? 'reference' : 'main',
                    reason: '对应问题',
                    basis: 'model_assessment',
                    timeScope: 'unknown',
                    assessment: {
                        relevance: 'direct',
                        support: 'partial',
                        role: 'answer',
                        sourceRelation: 'unknown',
                        reason: '与问题相关，仍需补充适用范围',
                        conditions: '',
                        gap: '适用范围尚未核对',
                    },
                })),
            };
            const before = structuredClone(report);
            const document = await render(format, parseContract(ReportSchema, report));
            const groups = [...document.querySelectorAll('#question-q0 > .answer-source')];
            expect(
                groups.map((group) => [...group.querySelectorAll('.claim')].map((node) => node.id)),
            ).toEqual([
                [10, 14].map((n) => `claim-${id(n)}`),
                [`claim-${id(11)}`],
                [`claim-${id(13)}`],
            ]);
            expect(
                groups.map((group) =>
                    [...group.querySelectorAll('blockquote')].map((node) => node.textContent),
                ),
            ).toEqual([
                [quote(report, id(20))],
                [quote(report, id(21))],
                [quote(report, id(20)), quote(report, id(21))],
            ]);
            expect(groups[0]!.querySelectorAll('.claim-sources a')).toHaveLength(2);
            expect(document.querySelector(`#claim-${id(12)} .evidence`)).toBeNull();
            for (const link of document.querySelectorAll('.claim-sources a')) {
                expect(document.getElementById(link.getAttribute('href')!.slice(1))).not.toBeNull();
            }
            const other = document.querySelector('#question-q1')!;
            expect(other.querySelector(`a[href="#claim-${id(10)}"]`)).not.toBeNull();
            expect(other.querySelectorAll('.claim')).toHaveLength(1);
            expect(other.querySelectorAll('blockquote')).toHaveLength(1);
            const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(report).toEqual(before);
        },
    );

    it.each(formats)(
        '%s retains every claim, original text/confidence and ordered claim citations',
        async (format) => {
            const report = fixture();
            const before = structuredClone(report);
            const document = await render(format, report);
            const expected = [11, 10, 14, 13, 12].map(id);
            expect([...document.querySelectorAll('.claim')].map((node) => node.id)).toEqual(
                expected.map((value) => `claim-${value}`),
            );
            for (const claim of report.claims) {
                const node = document.getElementById(`claim-${claim.id}`)!;
                expect(text(node, '.claim-text')).toBe(claim.text);
                expect(text(node, '.confidence')).toBe(`证据说明：${claim.confidenceLabel}`);
                expect([...node.querySelectorAll('.citation')].map((entry) => entry.id)).toEqual(
                    claim.evidenceIds.map((value) => `claim-${claim.id}-evidence-${value}`),
                );
                expect(evidenceQuotes(node, '.citation blockquote')).toEqual(
                    claim.evidenceIds.map((value) => quote(report, value)),
                );
            }
            expect(report).toEqual(before);
        },
    );

    it.each(formats)(
        '%s preserves all seven change categories, values, reasons and distinct evidence sides',
        async (format) => {
            const report = fixture();
            const document = await render(format, report);
            const rows =
                format === 'comparison'
                    ? [...document.querySelectorAll('tbody > tr')]
                    : [...document.querySelectorAll('.change-record')];
            expect(rows).toHaveLength(report.changes.length);
            for (const [index, change] of report.changes.entries()) {
                const row = rows[index]!;
                expect(row.textContent).toContain(change.factKey);
                expect(row.textContent).toContain(change.reason);
                expect(
                    text(
                        row,
                        format === 'comparison'
                            ? '.old-side .original-text'
                            : '.old-side .change-value',
                    ),
                ).toContain(change.oldValue ?? '未提供旧值');
                expect(
                    text(
                        row,
                        format === 'comparison'
                            ? '.new-side .original-text'
                            : '.new-side .change-value',
                    ),
                ).toContain(change.newValue ?? '未提供新值');
                expect(evidenceQuotes(row, '.old-side blockquote')).toEqual(
                    change.oldEvidenceIds.map((value) => quote(report, value)),
                );
                expect(evidenceQuotes(row, '.new-side blockquote')).toEqual(
                    change.newEvidenceIds.map((value) => quote(report, value)),
                );
                if (change.important) expect(row.textContent).toContain('重要性标记：重要');
            }
        },
    );

    it.each(formats)(
        '%s renders every source in saved order including change-only and orphan evidence',
        async (format) => {
            const report = fixture();
            const document = await render(format, report);
            const entries = [...document.querySelectorAll('.evidence-appendix .evidence-entry')];
            expect(entries.map((node) => node.id)).toEqual(
                report.evidence.map((entry) => `evidence-${entry.id}`),
            );
            for (const [index, entry] of report.evidence.entries()) {
                const node = entries[index]!;
                expect(text(node, 'summary')).toBe(`${entry.title} · 查看原文引用`);
                expect(text(node, 'blockquote')).toBe(entry.quote);
                expect(node.textContent).toContain(entry.location);
                expect(node.querySelector('time')?.getAttribute('datetime')).toBe(entry.observedAt);
                expect(node.querySelector('a')?.getAttribute('href')).toBe(entry.url);
            }
            expect(document.querySelectorAll('#saved-evidence-title')).toHaveLength(1);
            const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(document.querySelector('script, b, em')).toBeNull();
            expect(text(document, '#report-title')).toBe(report.title);
            expect(document.querySelector('.metadata')?.textContent).toContain(
                report.taskVersionId,
            );
            expect(document.querySelector('.metadata time')?.getAttribute('datetime')).toBe(
                report.publishedAt,
            );
            expect(text(document, '.mode')).toContain('演示报告');
            expect(text(document, '.report-warning')).toContain('结果已整理当前查阅到的内容');
            expect(text(document, '.report-warning a')).toBe('查看完整限制与缺口');
            expect(text(document, '.coverage details')).toContain('原始限制');
            expect(text(document, '.coverage details')).toContain('原始覆盖缺口');
            expect(
                document
                    .querySelector('.report-warning')!
                    .compareDocumentPosition(document.querySelector('#summary-title')!) &
                    Node.DOCUMENT_POSITION_PRECEDING,
            ).toBeTruthy();
            expect(text(document, '.coverage')).toContain('保存的查询');
        },
    );
    it.each(formats)(
        '%s retains uncertain content without attributing unrelated sources as supporting quotes',
        async (format) => {
            const report = fixture();
            report.coverage.notes = ['只筛选部分候选，不代表引擎失败。'];
            const claim = report.claims.find((c) => c.kind === 'insufficient')!;
            claim.text = '待核实的模型判断 <script>doNotRun()</script>';
            const document = await render(format, report);
            const node = document.getElementById(`claim-${claim.id}`)!;
            expect(node.textContent).toContain('待核实');
            expect(node.textContent).toContain(claim.text);
            expect(node.querySelectorAll('.citation')).toHaveLength(0);
            expect(node.querySelector('script')).toBeNull();
            expect(document.body.textContent).toContain('只筛选部分候选，不代表引擎失败。');
        },
    );

    it.each(formats)(
        '%s preserves authoritative empty-change outcomes with or without a baseline',
        async (format) => {
            for (const [outcome, expected] of [
                ['baseline', '本次建立比较基线'],
                ['no_important_change', '本次范围内未发现重要变化'],
                ['inconclusive', '变化结论仍不确定'],
            ] as const) {
                for (const baselineRunId of [null, id(5)]) {
                    const report = parseContract(ReportSchema, {
                        ...fixture(),
                        changes: [],
                        outcome,
                        baselineRunId,
                        mode: 'live',
                        limitations: [],
                        coverage: {
                            completeness: 'complete',
                            searchedQueries: [],
                            gaps: [],
                            exhausted: [],
                        },
                    });
                    const document = await render(format, report);
                    expect(text(document, '.comparison-summary')).toContain(expected);
                    expect(document.body.textContent).toContain(
                        baselineRunId ?? '报告未提供关联的基线执行。',
                    );
                    expect(document.querySelectorAll('.change-record, tbody > tr')).toHaveLength(0);
                    expect(document.querySelector('.report-warning')).toBeNull();
                    expect(text(document, '.mode')).toBe('真实查阅报告');
                }
            }
            const partial = parseContract(ReportSchema, {
                ...fixture(),
                changes: [],
                baselineRunId: null,
            });
            const document = await render(format, partial);
            expect(text(document, '.comparison-summary')).toContain('不能据此认定没有重要变化');
            expect(text(document, '.report-warning')).toContain('查阅范围说明');
        },
    );

    it.each(formats)(
        'ReportDetail composes the saved %s renderer and keeps reading controls outside it',
        async (format) => {
            const report = parseContract(ReportSchema, { ...fixture(), format });
            const requests: string[] = [];
            const lifecycle: SessionLifecycle = sessionModule.createSessionLifecycle({
                fetcher: async (url) => {
                    requests.push(
                        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
                    );
                    return Response.json(
                        {
                            code: 'UNCONFIGURED_TEST_ENDPOINT',
                            message: 'not configured',
                            requestId: 'formats',
                        },
                        { status: 501 },
                    );
                },
            });
            lifecycle.replaceSession(account);
            const router = createRouter({
                history: createMemoryHistory(),
                routes: [{ path: '/reports/:reportId', component: detail }],
            });
            const address = `/reports/${report.id}?questionId=invalid&view=ignored&extra=a&extra=b#unchanged`;
            await router.push(address);
            await router.isReady();
            const options = lifecycle.queryOptions(
                reportModule.reportEndpoint,
                { params: { reportId: report.id } },
                ['reports', report.id],
            );
            lifecycle.queryClient.setQueryData(options.queryKey, {
                data: report,
                status: 200,
                headers: new Headers(),
                url: `/api/v1/reports/${report.id}`,
            });
            try {
                const output = await renderToString(
                    createSSRApp({ render: () => h(detail) })
                        .use(lifecycle.pinia)
                        .use(router)
                        .provide(sessionModule.sessionLifecycleKey, lifecycle),
                );
                const document = new DOMParser().parseFromString(output, 'text/html');
                const selectors = {
                    brief: '.report-brief',
                    list: '.report-topic-list',
                    comparison: '.report-comparison',
                    research_report: '.research-report',
                };
                expect(document.querySelectorAll(selectors[format])).toHaveLength(1);
                const selector = document.querySelector<HTMLSelectElement>('#report-format')!;
                expect(selector.value).toBe(format);
                expect(selector.closest('.report-frame')).toBeNull();
                expect([...selector.options].map((option) => option.value)).toEqual(formats);
                expect(document.querySelector('.questions')).not.toBeNull();
                expect(document.querySelector('#report-format-help')?.textContent).toContain(
                    '刷新恢复',
                );
                expect(
                    document.querySelector('.report-sections a:nth-child(2)')?.getAttribute('href'),
                ).toBe(format === 'comparison' ? '#comparison-title' : '#report-changes-title');
                expect(router.currentRoute.value.fullPath).toBe(address);
                expect(requests.some((url) => url.endsWith(`/reports/${report.id}`))).toBe(false);
                expect(report.format).toBe(format);
            } finally {
                lifecycle.dispose();
            }
        },
    );
});
