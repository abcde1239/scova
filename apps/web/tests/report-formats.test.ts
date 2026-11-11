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
import { artifactReport, savedArtifactFormats } from '@/utils/report-artifacts';
import { groupEvidence } from '@/utils/evidence-groups';

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

describe('saved report artifacts', () => {
    it('keeps legacy reports fixed and projects independent claims without mutating saved data', () => {
        const report = fixture();
        expect(savedArtifactFormats(report)).toEqual(['brief']);
        expect(artifactReport(report, 'research_report')).toBe(report);
        report.coverage.artifacts = [
            { format: 'brief', claimIndexes: [0] },
            { format: 'comparison', claimIndexes: [1, 3] },
        ];
        const before = structuredClone(report);
        const brief = artifactReport(report, 'brief');
        const comparison = artifactReport(report, 'comparison');
        expect(savedArtifactFormats(report)).toEqual(['brief', 'comparison']);
        expect(brief.claims.map((claim) => claim.id)).toEqual([report.claims[0]!.id]);
        expect(comparison.claims.map((claim) => claim.id)).toEqual([
            report.claims[1]!.id,
            report.claims[3]!.id,
        ]);
        expect(brief.summary).not.toBe(comparison.summary);
        expect(report).toEqual(before);
    });

    it('remaps question and selection indexes per artifact and recalculates answer delivery', () => {
        const report = fixture();
        report.coverage.artifacts = [
            { format: 'brief', claimIndexes: [0] },
            { format: 'list', claimIndexes: [1] },
        ];
        report.coverage.reportValue = {
            version: 1,
            questions: [
                {
                    id: 'q0',
                    text: '核心问题',
                    priority: 'core',
                    status: 'provisional',
                    claimIndexes: [1],
                    gap: '保留条件',
                },
            ],
            selections: report.claims.map((_, claimIndex) => ({
                claimIndex,
                questionIds: claimIndex === 1 ? ['q0'] : [],
                placement: claimIndex === 1 ? 'main' : 'reference',
                reason: '已保存选择',
                basis: 'model_assessment',
                timeScope: 'unknown',
                assessment: {
                    relevance: 'direct',
                    support: 'partial',
                    role: 'answer',
                    sourceRelation: 'unknown',
                    reason: '有依据',
                    conditions: '限制条件',
                    gap: '保留条件',
                },
            })),
        };
        const brief = artifactReport(report, 'brief');
        const list = artifactReport(report, 'list');
        expect(brief.coverage.reportValue?.questions[0]?.status).toBe('unresolved');
        expect(brief.coverage.delivery?.answeredCoreQuestions).toBe(0);
        expect(list.coverage.reportValue?.questions[0]?.claimIndexes).toEqual([0]);
        expect(list.coverage.reportValue?.selections[0]?.claimIndex).toBe(0);
        expect(list.coverage.delivery?.answeredCoreQuestions).toBe(1);
        expect(list.coverage.reportValue?.selections[0]?.assessment?.conditions).toBe('限制条件');
    });

    it('groups a source snapshot once and keeps different saved versions distinct', () => {
        const report = fixture();
        const original = report.evidence[0]!;
        const copy = { ...original, id: id(90), quote: '同页第二条逐字引用' };
        const differentVersion = { ...original, id: id(91), snapshotId: id(92) };
        const groups = groupEvidence([original, copy, differentVersion]);
        expect(groups).toHaveLength(2);
        expect(groups[0]?.evidence.map((entry) => entry.id)).toEqual([original.id, copy.id]);
        expect(groups[1]?.evidence).toEqual([differentVersion]);
    });

    it('preserves the saved single-format summary and does not replace a covered subquestion', () => {
        const report = fixture();
        report.claims = report.claims.filter((claim) => claim.kind !== 'insufficient');
        report.summary = '缓存存储条件，以及 ETag / 304 的完整摘要';
        report.coverage.artifacts = [{ format: 'brief', claimIndexes: [0, 1, 2, 3] }];
        expect(artifactReport(report, 'brief').summary).toBe(report.summary);
    });

    it('covers later questions in a multi-format summary and excludes insufficient conclusions', () => {
        const report = fixture();
        report.claims[0]!.text = '缓存存储条件';
        report.claims[1]!.text = 'ETag 与 304 的交互';
        report.claims[2]!.text = '不可推广的未核实结论';
        report.coverage.artifacts = [
            { format: 'brief', claimIndexes: [0, 2, 1] },
            { format: 'list', claimIndexes: [4] },
        ];
        report.coverage.reportValue = {
            version: 1,
            questions: [
                {
                    id: 'q0',
                    text: '缓存',
                    priority: 'core',
                    status: 'provisional',
                    claimIndexes: [0, 2],
                    gap: '',
                },
                {
                    id: 'q1',
                    text: '验证',
                    priority: 'supporting',
                    status: 'provisional',
                    claimIndexes: [1],
                    gap: '',
                },
            ],
            selections: report.claims.map((_, claimIndex) => ({
                claimIndex,
                questionIds: ['q0'],
                placement: 'main',
                reason: '测试保存索引',
                basis: 'unassessed',
                timeScope: 'unknown',
            })),
        };
        const projected = artifactReport(report, 'brief');
        expect(projected.summary).toContain('缓存存储条件');
        expect(projected.summary).toContain('ETag 与 304');
        expect(projected.summary).not.toContain('不可推广');
    });

    it('remaps structured artifact fields and coverage while retaining baseline-only source anchors', () => {
        const report = fixture();
        report.coverage.artifacts = [
            { format: 'brief', claimIndexes: [0, 2, 3] },
            {
                format: 'list',
                claimIndexes: [4, 1],
                summary: '独立保存摘要',
                coverage: {
                    version: 1,
                    requirements: [
                        {
                            id: 'r',
                            questionIds: ['q0'],
                            object: '指定对象',
                            field: '名称',
                            required: true,
                            status: 'supported',
                            claimIndexes: [1],
                            gap: '',
                        },
                    ],
                },
                content: {
                    version: 1,
                    list: {
                        entries: [
                            {
                                id: 'o',
                                name: '指定对象',
                                fields: [
                                    {
                                        id: 'f',
                                        label: '名称',
                                        text: '原文事实',
                                        claimIndexes: [1],
                                        status: 'supported',
                                        gap: '',
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
        ];
        const before = structuredClone(report);
        const projected = artifactReport(report, 'list');
        const artifact = projected.coverage.artifacts![0]!;
        expect(projected.summary).toBe('独立保存摘要');
        expect(artifact.coverage?.requirements[0]!.claimIndexes).toEqual([1]);
        expect(artifact.content?.list?.entries[0]!.fields[0]!.claimIndexes).toEqual([1]);
        expect(projected.claims[1]!.id).toBe(report.claims[1]!.id);
        expect(projected.evidence.map((entry) => entry.id)).toContain(id(22));
        expect(projected.changes).toEqual([]);
        expect(report).toEqual(before);
    });

    it('does not count a projected question as answered while required datetime fields are unknown', () => {
        const report = fixture();
        report.coverage.reportValue = {
            version: 1,
            questions: [
                {
                    id: 'q0',
                    text: '三个标准库用途',
                    priority: 'core',
                    status: 'provisional',
                    claimIndexes: [1],
                    gap: '',
                },
            ],
            selections: report.claims.map((_, claimIndex) => ({
                claimIndex,
                questionIds: claimIndex === 1 ? ['q0'] : [],
                placement: claimIndex === 1 ? 'main' : 'reference',
                reason: '保存的对应关系',
                basis: 'model_assessment',
                timeScope: 'unknown',
                assessment: {
                    relevance: 'direct',
                    support: 'partial',
                    role: 'answer',
                    sourceRelation: 'unknown',
                    reason: '只取得前两个对象',
                    conditions: '',
                    gap: '',
                },
            })),
        };
        report.coverage.artifacts = [
            {
                format: 'list',
                claimIndexes: [1, 2],
                coverage: {
                    version: 1,
                    requirements: [
                        {
                            id: 'json-purpose',
                            questionIds: ['q0'],
                            object: 'json',
                            field: '用途',
                            required: true,
                            status: 'supported',
                            claimIndexes: [1],
                            gap: '',
                        },
                        {
                            id: 'datetime-purpose',
                            questionIds: ['q0'],
                            object: 'datetime',
                            field: '用途',
                            required: true,
                            status: 'unknown',
                            claimIndexes: [],
                            gap: '未读取到 datetime 正文',
                        },
                    ],
                },
            },
        ];
        const projected = artifactReport(report, 'list');
        expect(projected.coverage.artifacts![0]!.coverage!.requirements[0]!.claimIndexes).toEqual([
            0,
        ]);
        expect(projected.coverage.delivery).toMatchObject({
            status: 'partial',
            answeredQuestions: 0,
            answeredCoreQuestions: 0,
        });
    });
});
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
    let structuredValue: Component;
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
        structuredValue = (
            await server.ssrLoadModule('/src/components/reports/ReportStructuredValue.vue')
        ).default as Component;
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

    it.each(['list', 'comparison'] as const)(
        '%s renders saved objects and fields without parsing claim text',
        async (format) => {
            const report = fixture();
            report.format = format;
            report.claims[0]!.text = '正文保留完整原话；这里没有可解析的对象冒号。';
            report.coverage.reportValue = {
                version: 1,
                questions: [
                    {
                        id: 'q0',
                        text: '所需资料',
                        priority: 'core',
                        status: 'provisional',
                        claimIndexes: [0],
                        gap: '',
                    },
                ],
                selections: report.claims.map((_, claimIndex) => ({
                    claimIndex,
                    questionIds: claimIndex === 0 ? ['q0'] : [],
                    placement: claimIndex === 0 ? 'main' : 'reference',
                    reason: '测试保存索引',
                    basis: 'unassessed',
                    timeScope: 'unknown',
                    ...(claimIndex === 0
                        ? {
                              assessment: {
                                  relevance: 'direct',
                                  support: 'partial',
                                  role: 'condition',
                                  sourceRelation: 'original',
                                  reason: '保留 watch 的来源类型条件',
                                  conditions: 'getter 默认浅层；直接 reactive 对象隐式 deep',
                                  gap: '未取得其它版本的行为',
                              },
                          }
                        : {}),
                })),
            };
            const supported = {
                text: '保留完整原话',
                claimIndexes: [0],
                status: 'supported',
                gap: '',
            } as const;
            const unknown = {
                text: '',
                claimIndexes: [],
                status: 'unknown',
                gap: '尚未取得模块 B 的入口',
            } as const;
            report.coverage.artifacts = [
                {
                    format,
                    claimIndexes: report.claims.map((_, index) => index),
                    summary: '独立安全摘要',
                    coverage: {
                        version: 1,
                        requirements: [
                            {
                                id: 'b-entry',
                                questionIds: ['q0'],
                                object: '模块 B',
                                field: '入口',
                                required: true,
                                status: 'unknown',
                                claimIndexes: [],
                                gap: unknown.gap,
                            },
                        ],
                    },
                    content: {
                        version: 1,
                        ...(format === 'list'
                            ? {
                                  list: {
                                      entries: [
                                          {
                                              id: 'a',
                                              name: '模块 A',
                                              fields: [
                                                  {
                                                      id: 'entry',
                                                      label: '入口',
                                                      ...supported,
                                                      claimIndexes: [0],
                                                  },
                                              ],
                                          },
                                          {
                                              id: 'b',
                                              name: '模块 B',
                                              fields: [
                                                  {
                                                      id: 'entry',
                                                      label: '入口',
                                                      ...unknown,
                                                      claimIndexes: [],
                                                  },
                                              ],
                                          },
                                      ],
                                  },
                              }
                            : {
                                  comparison: {
                                      objects: [
                                          { id: 'a', name: '模块 A' },
                                          { id: 'b', name: '模块 B' },
                                      ],
                                      dimensions: [{ id: 'entry', label: '入口' }],
                                      cells: [
                                          {
                                              objectId: 'a',
                                              dimensionId: 'entry',
                                              ...supported,
                                              claimIndexes: [0],
                                          },
                                          {
                                              objectId: 'b',
                                              dimensionId: 'entry',
                                              ...unknown,
                                              claimIndexes: [],
                                          },
                                      ],
                                  },
                              }),
                    },
                },
            ];
            const before = structuredClone(report);
            const document = await render(format, report);
            expect(text(document, '.answer-gaps')).toContain('模块 B · 入口');
            expect(
                document.querySelector('.answer-gaps')?.closest('details')?.hasAttribute('open'),
            ).toBe(false);
            expect(text(document, '.report-delivery')).toContain('部分内容待补充');
            expect(text(document, '.report-summary')).toContain('独立安全摘要');
            expect(text(document, '.structured-content')).toContain(unknown.gap);
            expect(text(document, '.structured-condition')).toContain(
                'getter 默认浅层；直接 reactive 对象隐式 deep',
            );
            expect(text(document, '.structured-gap')).toContain('未取得其它版本的行为');
            expect(document.querySelector('.structured-condition')?.closest('details')).toBeNull();
            expect(document.querySelector('.legacy-notice')).toBeNull();
            if (format === 'list') {
                expect(
                    [...document.querySelectorAll('.object-card h4')].map(
                        (entry) => entry.textContent,
                    ),
                ).toEqual(['模块 A', '模块 B']);
                expect(document.querySelectorAll('.object-card dt')).toHaveLength(2);
            } else {
                expect(
                    [...document.querySelectorAll('.object-matrix thead th')].map((entry) =>
                        entry.textContent?.trim(),
                    ),
                ).toEqual(['共同维度', '模块 A', '模块 B']);
                expect(text(document, '.object-matrix tbody th')).toBe('入口');
                expect(document.querySelectorAll('.object-matrix tbody td')).toHaveLength(2);
            }
            const claimLink = document.querySelector('.structured-links a')!;
            expect(
                document.getElementById(claimLink.getAttribute('href')!.slice(1)),
            ).not.toBeNull();
            expect(document.querySelectorAll('blockquote')).toHaveLength(report.evidence.length);
            expect(report).toEqual(before);
        },
    );

    it('structured values expose superseded references and pending support without promoting unknown fields', async () => {
        const report = fixture();
        report.coverage.reportValue = {
            version: 1,
            questions: [],
            selections: [
                {
                    claimIndex: 0,
                    questionIds: [],
                    placement: 'reference',
                    reason: '较早结论，已由新版本补充 reactive 对象的例外条件',
                    basis: 'model_assessment',
                    timeScope: 'unknown',
                    assessment: {
                        relevance: 'direct',
                        support: 'partial',
                        role: 'condition',
                        sourceRelation: 'original',
                        reason: '旧版本未完整保留条件',
                        conditions: '直接 reactive 对象隐式 deep',
                        gap: '其它调用方式仍需核实',
                    },
                },
                {
                    claimIndex: 1,
                    questionIds: [],
                    placement: 'main',
                    reason: '补充来源',
                    basis: 'unassessed',
                    timeScope: 'unknown',
                    assessment: {
                        relevance: 'direct',
                        support: 'partial',
                        role: 'condition',
                        sourceRelation: 'original',
                        reason: '重复条件应只显示一次',
                        conditions: '直接 reactive 对象隐式 deep',
                        gap: '其它调用方式仍需核实',
                    },
                },
            ],
        };
        const output = await renderToString(
            createSSRApp({
                render: () =>
                    h(structuredValue, {
                        report,
                        value: {
                            text: '旧版本片段',
                            claimIndexes: [0, 0, 1, 2],
                            status: 'partial',
                            gap: '资料不完整',
                        },
                    }),
            }),
        );
        const document = new DOMParser().parseFromString(output, 'text/html');
        expect(document.querySelectorAll('.structured-condition')).toHaveLength(1);
        expect(document.querySelectorAll('.structured-gap')).toHaveLength(1);
        expect(text(document, '.structured-value')).toContain(
            '关联内容为参考材料，未作为当前结论：较早结论，已由新版本补充 reactive 对象的例外条件',
        );
        expect(text(document, '.structured-value')).toContain(
            '关联内容待核实，尚不能作为已确认结论',
        );
        expect(document.querySelectorAll('.structured-links a')).toHaveLength(3);
        const unknown = await renderToString(
            createSSRApp({
                render: () =>
                    h(structuredValue, {
                        report,
                        value: {
                            text: '不应当作为可用字段显示的陈旧值',
                            claimIndexes: [],
                            status: 'unknown',
                            gap: '当前字段未知',
                        },
                    }),
            }),
        );
        expect(unknown).toContain('当前字段未知');
        expect(unknown).not.toContain('不应当作为可用字段显示的陈旧值');
    });

    it('shows one source heading for multiple quotes and retains duplicate evidence anchors', async () => {
        const report = fixture();
        const source = report.evidence[0]!;
        report.evidence.push(
            { ...source, id: id(90) },
            { ...source, id: id(91), quote: '同一保存版本中的另一个完整原句。' },
        );
        const before = structuredClone(report);
        const document = await render('brief', report);
        const appendix = document.querySelector('.evidence-appendix')!;
        const group = appendix.querySelector('.evidence-source-group')!;
        expect(text(group, ':scope > summary')).toContain('2条引用');
        expect(group.querySelectorAll('blockquote')).toHaveLength(2);
        expect(group.querySelector('blockquote')?.textContent).toBe(source.quote);
        expect(group.querySelector(`#evidence-${id(90)}`)).not.toBeNull();
        expect(group.querySelector(`#evidence-${id(91)}`)).not.toBeNull();
        expect(appendix.querySelectorAll('.evidence-source-group')).toHaveLength(
            before.evidence.length - 2,
        );
        expect(group.querySelector('script')).toBeNull();
        expect(report).toEqual(before);
    });

    it('concentrates duplicate retrieval notices in closed details after the answer', async () => {
        const report = fixture();
        report.limitations = ['来源甲读取失败', '  模型输入  已抽样  '];
        report.coverage.gaps = ['来源甲读取失败', '模型输入 已抽样', '来源乙读取失败'];
        report.coverage.notes = ['模型输入 已抽样', '  候选已筛选 ', '候选已筛选'];
        const before = structuredClone(report);
        const document = await render('brief', report);
        const details = document.querySelector('.coverage details')!;
        expect(details.hasAttribute('open')).toBe(false);
        const body = details.querySelector('.coverage-body')!;
        expect(body.textContent?.match(/来源甲读取失败/g)).toHaveLength(1);
        expect(body.textContent?.match(/来源乙读取失败/g)).toHaveLength(1);
        expect(body.textContent?.match(/模型输入 已抽样/g)).toHaveLength(1);
        expect(body.textContent?.match(/候选已筛选/g)).toHaveLength(1);
        expect(document.querySelector('.report-warning h3, .report-warning p')).toBeNull();
        expect(document.querySelector('.answer-gaps')?.closest('details')).toBe(details);
        expect(
            details.compareDocumentPosition(document.querySelector('#summary-title')!) &
                Node.DOCUMENT_POSITION_PRECEDING,
        ).toBeTruthy();
        expect(report).toEqual(before);
    });

    it('keeps independent unanswered questions and conflicts visible alongside missing fields', async () => {
        const report = fixture();
        report.coverage.reportValue = {
            version: 1,
            questions: [
                {
                    id: 'q0',
                    text: '模块 A 入口',
                    priority: 'core',
                    status: 'unresolved',
                    claimIndexes: [],
                    gap: '尚未取得入口',
                },
                {
                    id: 'q1',
                    text: '模块 B 版本差异',
                    priority: 'core',
                    status: 'disputed',
                    claimIndexes: [3],
                    gap: '两个来源存在冲突',
                },
                {
                    id: 'q2',
                    text: '模块 C 费用',
                    priority: 'supporting',
                    status: 'unresolved',
                    claimIndexes: [],
                    gap: '尚未取得费用',
                },
            ],
            selections: report.claims.map((_, claimIndex) => ({
                claimIndex,
                questionIds: claimIndex === 3 ? ['q1'] : [],
                placement: claimIndex === 3 ? 'main' : 'reference',
                reason: '保留来源分歧与待核材料',
                basis: claimIndex === 3 ? 'model_assessment' : 'unassessed',
                timeScope: 'unknown',
                ...(claimIndex === 3
                    ? {
                          assessment: {
                              relevance: 'direct',
                              support: 'partial',
                              role: 'comparison',
                              sourceRelation: 'unknown',
                              reason: '两个来源表述不一致',
                              conditions: '仅比较同版本',
                              gap: '两个来源存在冲突',
                          } as const,
                      }
                    : {}),
            })),
        };
        report.coverage.artifacts = [
            {
                format: 'brief',
                claimIndexes: report.claims.map((_, index) => index),
                coverage: {
                    version: 1,
                    requirements: [
                        {
                            id: 'a-entry',
                            object: '模块 A',
                            field: '入口',
                            questionIds: ['q0'],
                            required: true,
                            status: 'unknown',
                            claimIndexes: [],
                            gap: '尚未取得入口',
                        },
                    ],
                },
            },
        ];
        const before = structuredClone(report);
        const document = await render('brief', parseContract(ReportSchema, report));
        const overview = document.querySelector('.answer-gap-overview')!;
        expect(overview.closest('details')).toBeNull();
        expect(overview.textContent).toContain('模块 A · 入口（待补充）');
        expect(overview.textContent).toContain('模块 B 版本差异（存在分歧）');
        expect(overview.querySelector('a[href="#coverage-title"]')).not.toBeNull();
        expect(overview.querySelector('a[href="#question-q1"]')).not.toBeNull();
        const details = document.querySelector('.coverage details')!;
        expect(details.hasAttribute('open')).toBe(false);
        expect(details.textContent).toContain('模块 C 费用');
        expect(details.textContent).toContain('两个来源存在冲突');
        expect(details.textContent).toContain('尚不能下结论');
        expect(report).toEqual(before);
    });

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
            expect(text(document, '.report-delivery')).toContain('部分内容待补充');
            expect(text(document, '.report-delivery')).toContain('1/2');
            expect(text(document, '.answers')).toContain('有材料，仍需核对条件');
            expect(text(document, '.answer')).toContain('仅限申请阶段');
            expect(document.querySelector('#question-q1')?.textContent).toContain('尚无直接回答');
            expect(document.querySelectorAll('.references .claim')).toHaveLength(2);
            expect(document.querySelector(`#report-pending #claim-${id(12)}`)).not.toBeNull();
            expect(
                document.querySelector(`#report-pending #claim-${id(12)}`)?.closest('details')?.id,
            ).toBe('report-pending');
            expect(document.querySelector('#report-pending')?.hasAttribute('open')).toBe(false);
            expect(text(document, '.answer-gaps')).toContain('尚不能下结论');
            expect(document.getElementById(`claim-${id(14)}`)).toBeNull();
            expect(document.querySelectorAll('.answers script')).toHaveLength(0);
            const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
            expect(new Set(ids).size).toBe(ids.length);
        },
    );

    it.each(formats)(
        '%s centralizes source quotes without losing citation ownership or shared-answer anchors',
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
            const groups = [
                ...document.querySelectorAll('#question-q0 > .answer-body > .answer-source'),
            ];
            expect(
                groups.map((group) => [...group.querySelectorAll('.claim')].map((node) => node.id)),
            ).toEqual([
                [`claim-${id(10)}`],
                [`claim-${id(11)}`],
                [`claim-${id(13)}`],
                [`claim-${id(14)}`],
            ]);
            expect(
                groups.map((group) =>
                    [...group.querySelectorAll('blockquote')].map((node) => node.textContent),
                ),
            ).toEqual([[], [], [], []]);
            expect(groups[0]!.querySelectorAll('.citation')).toHaveLength(1);
            expect(document.querySelector(`#claim-${id(12)} .evidence`)).toBeNull();
            for (const link of document.querySelectorAll('.citation')) {
                expect(document.getElementById(link.getAttribute('href')!.slice(1))).not.toBeNull();
            }
            const other = document.querySelector('#question-q1')!;
            expect(other.querySelector(`a[href="#claim-${id(10)}"]`)).not.toBeNull();
            expect(other.querySelectorAll('.claim')).toHaveLength(1);
            expect(other.querySelectorAll('blockquote')).toHaveLength(0);
            expect(other.textContent).not.toContain(report.claims[0]!.text);
            expect(document.querySelectorAll('blockquote')).toHaveLength(report.evidence.length);
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
                expect(
                    [...node.querySelectorAll('.citation')].map((entry) =>
                        entry.getAttribute('href'),
                    ),
                ).toEqual(claim.evidenceIds.map((value) => `#evidence-${value}`));
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
                    ? [...document.querySelectorAll('.comparison-table tbody > tr')]
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
                expect(
                    [...row.querySelectorAll('.old-side .evidence-link')].map((entry) =>
                        entry.getAttribute('href'),
                    ),
                ).toEqual(change.oldEvidenceIds.map((value) => `#evidence-${value}`));
                expect(
                    [...row.querySelectorAll('.new-side .evidence-link')].map((entry) =>
                        entry.getAttribute('href'),
                    ),
                ).toEqual(change.newEvidenceIds.map((value) => `#evidence-${value}`));
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
                expect(text(node.closest('.evidence-source-group')!, ':scope > summary')).toContain(
                    entry.title,
                );
                expect(text(node, 'summary').trim()).toBe('采集与定位信息');
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
            expect(document.querySelector('.report-warning h3, .report-warning p')).toBeNull();
            expect(text(document, '.scope-status')).toBe('查看来源覆盖说明');
            expect(document.querySelector('.scope-status')?.getAttribute('href')).toBe(
                '#coverage-title',
            );
            expect(document.querySelector('.coverage details')?.hasAttribute('open')).toBe(false);
            expect(text(document, '.coverage details')).toContain('原始限制');
            expect(text(document, '.coverage details')).toContain('原始覆盖缺口');
            expect(
                document
                    .querySelector('.coverage')!
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
                    expect(
                        document.querySelectorAll('.change-record, .comparison-table tbody > tr'),
                    ).toHaveLength(0);
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
            expect(text(document, '.scope-status')).toBe('查看来源覆盖说明');
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
                expect(document.querySelector('#report-format')).toBeNull();
                expect(document.querySelector('[aria-label="已生成成果"]')).toBeNull();
                expect(document.querySelector('.artifact-kind')?.textContent).toBe(
                    {
                        brief: '简报',
                        list: '主题清单',
                        comparison: '对比表',
                        research_report: '研究报告',
                    }[format],
                );
                expect(document.querySelector('.questions')).not.toBeNull();
                expect(document.querySelector('#report-format-help')).toBeNull();
                expect(
                    document.querySelector('.report-sections a:nth-child(2)')?.getAttribute('href'),
                ).toBe('#report-changes-title');
                expect(
                    document.querySelector(
                        '.report-document .report-changes, .report-document .comparison-context',
                    ),
                ).toBeNull();
                expect(
                    document.querySelector(
                        '.report-content .report-baseline #report-changes-title',
                    ),
                ).not.toBeNull();
                expect(router.currentRoute.value.fullPath).toBe(address);
                expect(requests.some((url) => url.endsWith(`/reports/${report.id}`))).toBe(false);
                expect(report.format).toBe(format);
            } finally {
                lifecycle.dispose();
            }
        },
    );
});
