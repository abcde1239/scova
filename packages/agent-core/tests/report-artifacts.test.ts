import { describe, expect, it } from 'vite-plus/test';
import {
    parseContract,
    ReportArtifactSchema,
    classifyReportDelivery,
    validReportArtifacts,
    type ReportValue,
} from '@scova/models';
import {
    buildReportArtifacts,
    plannedRequirements,
    supersededArtifactClaims,
    type PlannedRequirement,
} from '../src/report/artifacts/index.ts';
import type { AgentClaim, AgentContext, ComparisonExtraction } from '../src/types.ts';

const questions = [{ id: 'q0', text: '比较甲乙价格与离线能力' }];
const requirements: PlannedRequirement[] = ['甲', '乙'].flatMap((name, oi) =>
    ['价格', '离线'].map((field, di) => ({
        id: `r${oi}${di}`,
        format: 'comparison',
        questionIds: ['q0'],
        object: name,
        field,
        required: true,
    })),
);
const context = {
    config: { outputFormat: 'comparison', outputFormats: ['comparison'] },
} as AgentContext;

describe('coverage plan projection before retrieval', () => {
    const allQuestions = [...questions, { id: 'q1', text: '补充比较适用条件' }];
    it('preserves the matrix and combines duplicate cell obligations without changing the receipt', () => {
        const data = {
            requirements: [
                ...requirements,
                { ...requirements[0]!, id: 'duplicate', questionIds: ['q1'], required: false },
            ],
        };
        const saved = structuredClone(data);
        expect(plannedRequirements(data, ['comparison'], allQuestions)).toBeNull();
        const frozen = plannedRequirements(data, ['comparison'], allQuestions, true, true)!;
        expect(frozen).toHaveLength(4);
        expect(frozen[0]).toMatchObject({
            id: 'r00',
            object: '甲',
            field: '价格',
            required: true,
            questionIds: ['q0', 'q1'],
        });
        expect(data).toEqual(saved);
    });
    it('adds the omitted original question without discarding any requested object or field', () => {
        const data = { requirements };
        const frozen = plannedRequirements(data, ['comparison'], allQuestions, true, true)!;
        expect(frozen.slice(0, 4)).toEqual(requirements);
        expect(frozen[4]).toMatchObject({
            object: '',
            questionIds: ['q1'],
            field: allQuestions[1]!.text,
            required: true,
        });
        const optional = {
            requirements: [
                ...requirements,
                { ...frozen[4]!, id: 'explicit-optional', required: false },
            ],
        };
        expect(
            plannedRequirements(optional, ['comparison'], allQuestions, true, true)!.at(-1),
        ).toMatchObject({ id: 'explicit-optional', required: true });
        expect(optional.requirements.at(-1)!.required).toBe(false);
    });
    it('does not repair an invalid matrix by dropping a missing cell', () => {
        expect(
            plannedRequirements(
                { requirements: requirements.slice(0, 3) },
                ['comparison'],
                questions,
                true,
                true,
            ),
        ).toBeNull();
    });
});
const assessment = {
    relevance: 'direct',
    support: 'direct',
    role: 'answer',
    sourceRelation: 'original',
    reason: '原文说明',
    conditions: '月付',
    gap: '',
} as const;
const claims: AgentClaim[] = [
    '甲价格100元。',
    '甲支持离线。',
    '乙价格80元。',
    '乙不支持离线。',
].map((text) => ({
    kind: 'inference',
    text,
    questionIds: ['q0'],
    citations: [{ pageId: 'p0', quote: text }],
    assessment,
}));
const value: ReportValue = {
    version: 1,
    timeless: true,
    questions: [
        {
            ...questions[0]!,
            status: 'supported',
            priority: 'core',
            claimIndexes: [0, 1, 2, 3],
            gap: '',
        },
    ],
    selections: claims.map((_c, claimIndex) => ({
        claimIndex,
        questionIds: ['q0'],
        placement: 'main',
        reason: '支持',
        basis: 'model_assessment',
        timeScope: 'unknown',
        assessment,
    })),
};
const receipt = (operationKey: string, data: unknown): ComparisonExtraction => ({
    operationKey,
    response: { mode: 'live', data, usage: { inputTokens: 1, outputTokens: 1, estimated: false } },
});
const plan = receipt('plan-0', { requirements });
const synthesis = (
    entries: unknown[] = requirements.map((r, index) => ({
        id: r.id,
        text: claims[index]!.text,
        claimIndexes: [index],
    })),
) =>
    receipt('synthesize-0', {
        claims,
        artifacts: [{ format: 'comparison', requirements: entries }],
    });
const build = (extractions = [synthesis()], source = claims, reportValue = value) =>
    buildReportArtifacts(
        context,
        questions,
        source,
        reportValue,
        plan,
        extractions,
        (raw) => raw as AgentClaim,
    );

describe('frozen artifact structures', () => {
    it('keeps a detail-qualified supported field when a later core-missing patch arrives', () => {
        const initial: AgentClaim = {
            ...claims[0]!,
            assessment: { ...assessment, gap: '未提供可选编号', gapKind: 'missing_detail' },
        };
        const partial: AgentClaim = {
            ...initial,
            text: '甲价格仍需确认。',
            assessment: {
                ...assessment,
                support: 'partial',
                gap: '价格未知',
                gapKind: 'missing_core',
            },
        };
        const source = [initial, partial];
        const reportValue: ReportValue = {
            ...value,
            selections: source.map((claim, i) => ({
                ...value.selections[0]!,
                claimIndex: i,
                assessment: claim.assessment,
            })),
        };
        const make = (claim: AgentClaim, key: string) =>
            receipt(key, {
                claims: [claim],
                artifacts: [
                    {
                        format: 'comparison',
                        requirements: [{ id: 'r00', text: claim.text, claimIndexes: [0] }],
                    },
                ],
            });
        const artifact = buildReportArtifacts(
            context,
            questions,
            source,
            reportValue,
            plan,
            [make(initial, 'synthesize-0'), make(partial, 'synthesize-1')],
            (raw) => raw as AgentClaim,
            true,
            true,
            true,
            { gapKinds: true },
        )[0]!;
        expect(artifact.coverage?.requirements[0]).toMatchObject({
            status: 'supported',
            claimIndexes: [0],
        });
        expect(source[0]!.assessment?.gap).toBe('未提供可选编号');
    });
    it('retains a supported field when a later field patch provides only partial support', () => {
        const partial = {
            ...claims[0]!,
            text: '甲价格可能为100元。',
            assessment: { ...assessment, support: 'partial' as const, gap: '尚缺月付条件' },
        };
        const source = [...claims, partial];
        const reportValue: ReportValue = {
            ...value,
            selections: [
                ...value.selections,
                {
                    ...value.selections[0]!,
                    claimIndex: 4,
                    assessment: partial.assessment,
                },
            ],
        };
        const repair = receipt('synthesize-1', {
            claims: [partial],
            artifacts: [
                {
                    format: 'comparison',
                    requirements: [{ id: 'r00', text: partial.text, claimIndexes: [0] }],
                },
            ],
        });
        const artifact = buildReportArtifacts(
            context,
            questions,
            source,
            reportValue,
            plan,
            [synthesis(), repair],
            (raw) => raw as AgentClaim,
            true,
            true,
        )[0]!;
        expect(artifact.coverage?.requirements[0]).toMatchObject({
            status: 'supported',
            claimIndexes: [0],
        });
        expect(artifact.content?.comparison?.cells[0]?.text).toBe(claims[0]!.text);
    });
    it('merges disjoint groups of the same format instead of silently dropping later objects', () => {
        const entries = requirements.map((r, index) => ({
            id: r.id,
            text: claims[index]!.text,
            claimIndexes: [index],
        }));
        const artifact = build([
            receipt('synthesize-0', {
                claims,
                artifacts: [
                    { format: 'comparison', requirements: entries.slice(0, 2) },
                    { format: 'comparison', requirements: entries.slice(2) },
                ],
            }),
        ])[0]!;
        expect(artifact.coverage?.requirements.every((r) => r.status === 'supported')).toBe(true);
        expect(artifact.content?.comparison?.cells.map((c) => c.text)).toEqual(
            claims.map((c) => c.text),
        );
    });
    it('rejects duplicate requirement declarations within one receipt and retains an older valid answer', () => {
        const ambiguous = receipt('synthesize-1', {
            claims,
            artifacts: [
                {
                    format: 'comparison',
                    requirements: [{ id: 'r00', text: claims[0]!.text, claimIndexes: [0] }],
                },
                {
                    format: 'comparison',
                    requirements: [{ id: 'r00', text: claims[2]!.text, claimIndexes: [2] }],
                },
            ],
        });
        expect(build([ambiguous])[0]?.coverage?.requirements[0]?.status).toBe('unknown');
        expect(build([synthesis(), ambiguous])[0]?.coverage?.requirements[0]?.claimIndexes).toEqual(
            [0],
        );
    });
    it('retains the full conditional claim when a matrix value omits its exception', () => {
        const scoped = claims.map((c, index) =>
            index ? c : { ...c, text: '默认浅层监听，但直接对象输入会隐式深度监听。' },
        );
        const artifact = build(
            [
                receipt('synthesize-0', {
                    claims: scoped,
                    artifacts: [
                        {
                            format: 'comparison',
                            requirements: [{ id: 'r00', text: '默认浅层监听', claimIndexes: [0] }],
                        },
                    ],
                }),
            ],
            scoped,
        )[0]!;
        expect(artifact.content?.comparison?.cells[0]?.text).toBe(scoped[0]!.text);
        expect(validReportArtifacts([artifact], scoped, value)).toBe(true);
    });
    it('does not treat a synthetic generic fallback as proven full coverage', () => {
        const artifact = buildReportArtifacts(
            context,
            questions,
            claims,
            value,
            undefined,
            [
                receipt('synthesize-0', {
                    claims,
                    artifacts: [
                        {
                            format: 'comparison',
                            requirements: [
                                { id: 'comparison-q0', text: claims[0]!.text, claimIndexes: [0] },
                            ],
                        },
                    ],
                }),
            ],
            (raw) => raw as AgentClaim,
        )[0]!;
        expect(artifact.coverage?.requirements[0]?.status).toBe('partial');
        expect(classifyReportDelivery(value, claims, [artifact]).status).toBe('partial');
    });
    it('keeps valid forms when one comparison plan has incomplete shared dimensions', () => {
        const multi = {
            config: { outputFormat: 'list', outputFormats: ['list', 'comparison'] },
        } as AgentContext;
        const planned = [
            {
                id: 'list-one',
                format: 'list',
                questionIds: ['q0'],
                object: '甲',
                field: '名称',
                required: true,
            },
            ...requirements.slice(0, 3),
        ];
        const artifacts = buildReportArtifacts(
            multi,
            questions,
            claims,
            value,
            receipt('plan-0', { requirements: planned }),
            [
                receipt('synthesize-0', {
                    claims,
                    artifacts: [
                        {
                            format: 'list',
                            requirements: [
                                { id: 'list-one', text: claims[0]!.text, claimIndexes: [0] },
                            ],
                        },
                    ],
                }),
            ],
            (raw) => raw as AgentClaim,
        );
        expect(artifacts[0]?.content?.list?.entries[0]?.name).toBe('甲');
        expect(artifacts[0]?.coverage?.requirements[0]?.status).toBe('supported');
        expect(artifacts[1]?.coverage?.requirements.map((r) => r.id)).toEqual(
            requirements.slice(0, 3).map((r) => r.id),
        );
        expect(artifacts[1]?.content).toBeUndefined();
    });
    it('retires only the old same-field answer with overlapping source evidence', () => {
        const evidence =
            'This is a sufficiently long identical source statement supporting the answer.';
        const prior = claims.map((c) => ({ ...c, citations: [{ pageId: 'p0', quote: evidence }] }));
        const newer: AgentClaim = {
            ...prior[0]!,
            text: '甲价格100元，仅限月付条件。',
            citations: [{ pageId: 'p0', quote: `${evidence} Additional material conditions.` }],
        };
        const combined = [...prior, newer];
        const assessed: ReportValue = {
            ...value,
            selections: [...value.selections, { ...value.selections[0]!, claimIndex: 4 }],
        };
        const old = receipt('synthesize-0', {
            claims: prior,
            artifacts: [
                {
                    format: 'comparison',
                    requirements: requirements.map((r, index) => ({
                        id: r.id,
                        text: prior[index]!.text,
                        claimIndexes: [index],
                    })),
                },
            ],
        });
        const updated = receipt('synthesize-1', {
            claims: [newer],
            artifacts: [
                {
                    format: 'comparison',
                    requirements: [{ id: 'r00', text: newer.text, claimIndexes: [0] }],
                },
            ],
        });
        const artifacts = build([old, updated], combined, assessed);
        expect([
            ...supersededArtifactClaims(
                combined,
                assessed,
                artifacts,
                [old, updated],
                (raw) => raw as AgentClaim,
            ),
        ]).toEqual([0]);
        const conflict = combined.map((c, index) =>
            index === 4 ? { ...c, kind: 'conflict' as const } : c,
        );
        expect(
            supersededArtifactClaims(
                conflict,
                assessed,
                artifacts,
                [old, updated],
                (raw) => raw as AgentClaim,
            ).size,
        ).toBe(0);
        const otherSource = combined.map((c, index) =>
            index === 4 ? { ...c, citations: [{ pageId: 'p2', quote: evidence }] } : c,
        );
        expect(
            supersededArtifactClaims(
                otherSource,
                assessed,
                artifacts,
                [old, updated],
                (raw) => raw as AgentClaim,
            ).size,
        ).toBe(0);
    });
    it('builds an actual object × shared-dimension matrix with distinct supported values', () => {
        const artifact = parseContract(ReportArtifactSchema, build()[0]);
        expect(artifact.content?.comparison?.objects.map((o) => o.name)).toEqual(['甲', '乙']);
        expect(artifact.content?.comparison?.dimensions.map((d) => d.label)).toEqual([
            '价格',
            '离线',
        ]);
        expect(artifact.content?.comparison?.cells.map((c) => c.text)).toEqual(
            claims.map((c) => c.text),
        );
        expect(validReportArtifacts([artifact], claims, value)).toBe(true);
        expect(classifyReportDelivery(value, claims, [artifact]).status).toBe('answered');
    });
    it('keeps a missing requested object visible and prevents one side completing the compound goal', () => {
        const artifact = build([
            synthesis([
                { id: 'r00', text: claims[0]!.text, claimIndexes: [0] },
                { id: 'r01', text: claims[1]!.text, claimIndexes: [1] },
            ]),
        ])[0]!;
        expect(artifact.content?.comparison?.cells.slice(2).map((c) => [c.text, c.status])).toEqual(
            [
                ['', 'unknown'],
                ['', 'unknown'],
            ],
        );
        expect(artifact.coverage?.requirements.filter((r) => r.required)).toHaveLength(4);
        expect(classifyReportDelivery(value, claims, [artifact])).toMatchObject({
            status: 'partial',
            answeredCoreQuestions: 0,
        });
        expect(artifact.summary).toContain('2项');
    });
    it('separates cited content coverage from unknown publication time', () => {
        const dated: ReportValue = {
            ...value,
            timeless: undefined,
            questions: value.questions.map((q) => ({
                ...q,
                status: 'provisional',
                gap: '时间范围尚未核验',
            })),
        };
        const artifact = build([synthesis()], claims, dated)[0]!;
        expect(artifact.coverage?.requirements.every((r) => r.status === 'supported')).toBe(true);
        expect(classifyReportDelivery(dated, claims, [artifact]).status).toBe('answered');
        expect(dated.questions[0]!.status).toBe('provisional');
    });
    it('cannot promote an invented cell value by attaching a genuine unrelated claim', () => {
        const artifact = build([
            synthesis([{ id: 'r00', text: '甲免费且永远可用。', claimIndexes: [0] }]),
        ])[0]!;
        expect(artifact.content?.comparison?.cells[0]).toMatchObject({
            text: '甲价格100元。',
            status: 'supported',
            claimIndexes: [0],
        });
        expect(artifact.content?.comparison?.cells[0]?.text).not.toContain('免费');
    });
    it('does not repair display text by switching to an unlinked object claim', () => {
        const artifact = build([
            synthesis([{ id: 'r00', text: '甲价格应采用该项。', claimIndexes: [2] }]),
        ])[0]!;
        expect(artifact.content?.comparison?.cells[0]).toMatchObject({
            text: '',
            status: 'unknown',
            claimIndexes: [],
        });
    });
    it('recovers the complete verified Vue watcher answers from noncontiguous display paraphrases', () => {
        const source: AgentClaim[] = [
            {
                ...claims[0]!,
                text: '在异步回调中创建的 watcher（例如在 setTimeout 内调用 watchEffect）不会自动停止：它不会绑定到所属组件，必须手动停止以避免内存泄漏。',
                citations: [
                    {
                        pageId: 'p0',
                        quote: "if the watcher is created in an async callback, it won't be bound to the owner component and must be stopped manually to avoid memory leaks",
                    },
                ],
            },
            {
                ...claims[0]!,
                text: '手动停止 watcher 的方法是使用创建时返回的停止句柄函数（示例中为 unwatch()），该方式对 watch 和 watchEffect 均适用。',
                citations: [
                    {
                        pageId: 'p0',
                        quote: 'To manually stop a watcher, use the returned handle function. This works for both watch and watchEffect:',
                    },
                ],
            },
        ];
        const frozen: PlannedRequirement[] = [
            {
                ...requirements[0]!,
                id: 'async',
                format: 'list',
                object: '异步回调创建的 watcher',
                field: '是否自动停止',
            },
            {
                ...requirements[0]!,
                id: 'manual',
                format: 'list',
                object: 'watcher',
                field: '手动停止方法',
            },
        ];
        const entries = [
            {
                id: 'async',
                text: '在异步回调中创建的 watcher 不会自动停止：它不会绑定到所属组件，必须手动停止以避免内存泄漏',
                claimIndexes: [0],
            },
            {
                id: 'manual',
                text: '使用创建时返回的停止句柄函数（示例中为 unwatch()），对 watch 和 watchEffect 均适用',
                claimIndexes: [1],
            },
        ];
        expect(entries.every((entry, index) => !source[index]!.text.includes(entry.text))).toBe(
            true,
        );
        const artifact = buildReportArtifacts(
            { config: { outputFormat: 'list', outputFormats: ['list'] } } as AgentContext,
            questions,
            source,
            value,
            receipt('plan-0', { requirements: frozen }),
            [
                receipt('synthesize-0', {
                    claims: source,
                    artifacts: [{ format: 'list', requirements: entries }],
                }),
            ],
            (raw) => raw as AgentClaim,
        )[0]!;
        expect(
            artifact.content?.list?.entries
                .flatMap((item) => item.fields)
                .map((entry) => [entry.text, entry.status, entry.claimIndexes]),
        ).toEqual(source.map((claim, index) => [claim.text, 'supported', [index]]));
        expect(validReportArtifacts([artifact], source, value)).toBe(true);
    });
    it.each([
        ['异步回调创建的 watcher', '同步回调中创建的 watcher 会自动停止。'],
        ['Vue 3.5 watcher', 'Vue 3.50 watcher 支持该操作。'],
        ['watch', 'watcher 支持该操作。'],
        ['异步回调创建的 watcher', 'watcher 支持该操作。'],
    ])('does not discard object scope or identifier boundaries when repairing %s', (name, text) => {
        const source = [
            {
                ...claims[0]!,
                text,
                assessment: { ...assessment, conditions: '异步回调创建的' },
                citations: [{ pageId: 'p0', quote: 'watcher' }],
            },
        ];
        const artifact = buildReportArtifacts(
            { config: { outputFormat: 'brief', outputFormats: ['brief'] } } as AgentContext,
            questions,
            source,
            value,
            receipt('plan-0', {
                requirements: [{ ...requirements[0]!, format: 'brief', object: name }],
            }),
            [
                receipt('synthesize-0', {
                    claims: source,
                    artifacts: [
                        {
                            format: 'brief',
                            requirements: [
                                { id: 'r00', text: '改写的显示文字。', claimIndexes: [0] },
                            ],
                        },
                    ],
                }),
            ],
            (raw) => raw as AgentClaim,
        )[0]!;
        expect(artifact.coverage?.requirements[0]).toMatchObject({
            status: 'unknown',
            claimIndexes: [],
        });
    });
    it('does not drop a condition from another linked claim to repair a compound field', () => {
        const source = [
            { ...claims[0]!, text: '甲支持该操作。' },
            { ...claims[1]!, text: '甲仅允许在同步阶段调用该操作。' },
        ];
        const artifact = build(
            [
                receipt('synthesize-0', {
                    claims: source,
                    artifacts: [
                        {
                            format: 'comparison',
                            requirements: [
                                {
                                    id: 'r00',
                                    text: '甲支持该操作，但必须同步执行。',
                                    claimIndexes: [0, 1],
                                },
                            ],
                        },
                    ],
                }),
            ],
            source,
        )[0]!;
        expect(artifact.content?.comparison?.cells[0]).toMatchObject({
            text: '',
            status: 'unknown',
            claimIndexes: [],
        });
    });
    it('uses a complete linked claim when it already contains the whole explicit group', () => {
        const source = [
            { ...claims[0]!, text: '甲支持该操作。甲仅允许在同步阶段调用该操作。' },
            { ...claims[1]!, text: '甲仅允许在同步阶段调用该操作。' },
        ];
        const artifact = build(
            [
                receipt('synthesize-0', {
                    claims: source,
                    artifacts: [
                        {
                            format: 'comparison',
                            requirements: [
                                {
                                    id: 'r00',
                                    text: '甲支持该操作，但必须同步执行。',
                                    claimIndexes: [0, 1],
                                },
                            ],
                        },
                    ],
                }),
            ],
            source,
        )[0]!;
        expect(artifact.content?.comparison?.cells[0]).toMatchObject({
            text: source[0]!.text,
            status: 'supported',
            claimIndexes: [0, 1],
        });
        expect(validReportArtifacts([artifact], source, value)).toBe(true);
    });
    it('does not truncate an oversized linked group to fit the display contract', () => {
        const source = [
            { ...claims[0]!, text: `甲${'完整说明'.repeat(300)}。` },
            { ...claims[1]!, text: `甲仅同步${'必要条件'.repeat(300)}。` },
        ];
        const artifact = build(
            [
                receipt('synthesize-0', {
                    claims: source,
                    artifacts: [
                        {
                            format: 'comparison',
                            requirements: [
                                {
                                    id: 'r00',
                                    text: '甲支持该操作，但必须同步执行。',
                                    claimIndexes: [0, 1],
                                },
                            ],
                        },
                    ],
                }),
            ],
            source,
        )[0]!;
        expect(artifact.content?.comparison?.cells[0]).toMatchObject({
            text: '',
            status: 'unknown',
            claimIndexes: [],
        });
    });
    it('keeps partial support partial when a display paraphrase falls back to a verified claim', () => {
        const source = claims.map((claim, index) =>
            index === 0
                ? {
                      ...claim,
                      assessment: {
                          ...assessment,
                          support: 'partial' as const,
                          gap: '计费周期仍有待确认',
                      },
                  }
                : claim,
        );
        const assessed = {
            ...value,
            selections: value.selections.map((selection, index) =>
                index === 0 ? { ...selection, assessment: source[0]!.assessment! } : selection,
            ),
        };
        const artifact = build(
            [
                receipt('synthesize-0', {
                    claims: source,
                    artifacts: [
                        {
                            format: 'comparison',
                            requirements: [
                                { id: 'r00', text: '甲的价格为100元（月付）。', claimIndexes: [0] },
                            ],
                        },
                    ],
                }),
            ],
            source,
            assessed,
        )[0]!;
        expect(artifact.content?.comparison?.cells[0]).toMatchObject({
            text: source[0]!.text,
            status: 'partial',
            claimIndexes: [0],
        });
        expect(assessed.selections[0]!.assessment?.gap).toBe('计费周期仍有待确认');
    });
    it.each([
        { text: '', claimIndexes: [0] },
        { text: '非连续改写。', claimIndexes: [0, 99] },
    ])('does not infer an explicit unknown or repair an invalid index group (%j)', (answer) => {
        const artifact = build([synthesis([{ id: 'r00', ...answer }])])[0]!;
        expect(artifact.content?.comparison?.cells[0]).toMatchObject({
            text: '',
            status: 'unknown',
            claimIndexes: [],
        });
    });
    it('cannot put a citation-downgraded claim into cells, coverage or the summary', () => {
        const downgraded: AgentClaim[] = claims.map((c) => ({
            ...c,
            kind: 'insufficient',
            uncertainty: ['quote_unmatched'],
        }));
        const artifact = build(
            [
                receipt('synthesize-0', {
                    claims: downgraded,
                    artifacts: [
                        {
                            format: 'comparison',
                            requirements: requirements.map((r, index) => ({
                                id: r.id,
                                text: downgraded[index]!.text,
                                claimIndexes: [index],
                            })),
                        },
                    ],
                }),
            ],
            downgraded,
        )[0]!;
        expect(artifact.coverage?.requirements.every((r) => r.status === 'unknown')).toBe(true);
        expect(artifact.summary).not.toContain('甲价格100元。');
    });
    it('preserves a valid old cell when a repair supplies an invalid replacement', () => {
        const artifact = build([
            synthesis(),
            synthesis([{ id: 'r00', text: '甲价格0元。', claimIndexes: [0] }]),
        ])[0]!;
        expect(artifact.content?.comparison?.cells[0]?.text).toBe('甲价格100元。');
    });
    it('synthesis cannot erase frozen requirements or turn them optional', () => {
        const artifact = build([
            receipt('synthesize-0', {
                claims,
                artifacts: [{ format: 'comparison', requirements: [] }],
            }),
        ])[0]!;
        expect(artifact.coverage?.requirements).toHaveLength(4);
        expect(
            artifact.coverage?.requirements.every((r) => r.required && r.status === 'unknown'),
        ).toBe(true);
    });
    it('rejects planning missing shared dimensions or original questions', () => {
        expect(
            plannedRequirements(
                { requirements: requirements.slice(0, 3) },
                ['comparison'],
                questions,
            ),
        ).toBeNull();
        expect(
            plannedRequirements(
                { requirements },
                ['comparison'],
                [...questions, { id: 'q1', text: '必须回答退款' }],
            ),
        ).toBeNull();
    });
});

describe('structured synthesis outline and groups', () => {
    const synthesisClaim: AgentClaim = {
        kind: 'inference',
        text: '乙更便宜，但只有甲支持离线。',
        questionIds: ['q0'],
        citations: [{ pageId: 'p0', quote: '甲价格100元。' }],
        assessment,
    };
    const allClaims = [...claims, synthesisClaim];
    const allValue: ReportValue = {
        ...value,
        selections: [...value.selections, { ...value.selections[0]!, claimIndex: 4 }],
    };
    const groupedPlan = receipt('plan-0', {
        requirements: requirements.map((r) => ({
            ...r,
            group: r.field === '价格' ? '成本' : '能力',
        })),
    });
    const withOutline = (document: unknown) =>
        receipt('synthesize-0', {
            claims: allClaims,
            artifacts: [
                {
                    format: 'comparison',
                    document,
                    requirements: requirements.map((r, index) => ({
                        id: r.id,
                        text: claims[index]!.text,
                        claimIndexes: [index],
                    })),
                },
            ],
        });
    const run = (extraction: ComparisonExtraction, planned = groupedPlan) =>
        buildReportArtifacts(
            context,
            questions,
            allClaims,
            allValue,
            planned,
            [extraction],
            (raw) => raw as AgentClaim,
        )[0]!;

    it('keeps the synthesis claim in a comparison outline and summarizes from it', () => {
        const artifact = run(
            withOutline({
                version: 1,
                sections: [{ id: 'core', title: '核心差异', role: 'overview', claimIndexes: [4] }],
            }),
        );
        expect(artifact.content?.comparison?.cells).toHaveLength(4);
        expect(artifact.content?.document?.sections).toEqual([
            { id: 'core', title: '核心差异', role: 'overview', claimIndexes: [4] },
        ]);
        expect(artifact.summary).toBe(synthesisClaim.text);
        expect(validReportArtifacts([artifact], allClaims, allValue)).toBe(true);
        expect(parseContract(ReportArtifactSchema, artifact)).toEqual(artifact);
    });
    it('never lets the outline claim a value already bound to a cell', () => {
        const artifact = run(
            withOutline({
                version: 1,
                sections: [
                    { id: 'core', title: '核心差异', role: 'overview', claimIndexes: [0, 4] },
                ],
            }),
        );
        expect(artifact.content?.document?.sections.flatMap((s) => s.claimIndexes)).toEqual([4]);
        expect(validReportArtifacts([artifact], allClaims, allValue)).toBe(true);
    });
    it('falls back to a structural summary instead of gluing cells when no outline exists', () => {
        const artifact = run(withOutline(null));
        expect(artifact.content?.document?.sections.flatMap((s) => s.claimIndexes)).toBeUndefined();
        expect(artifact.summary).toBe('2 个对象 × 2 个维度');
        expect(validReportArtifacts([artifact], allClaims, allValue)).toBe(true);
    });
    it('passes planned groups to dimensions and omits groups when the plan has none', () => {
        const grouped = run(withOutline(null));
        expect(grouped.content?.comparison?.dimensions.map((d) => d.group)).toEqual([
            '成本',
            '能力',
        ]);
        const plain = run(withOutline(null), plan);
        expect(plain.content?.comparison?.dimensions.every((d) => !('group' in d))).toBe(true);
    });
    it('accepts plans with blank or missing groups and rejects overlong groups', () => {
        const blank = requirements.map((r) => ({ ...r, group: '' }));
        expect(plannedRequirements({ requirements: blank }, ['comparison'], questions)).toEqual(
            requirements,
        );
        const long = requirements.map((r) => ({ ...r, group: '组'.repeat(41) }));
        expect(plannedRequirements({ requirements: long }, ['comparison'], questions)).toBeNull();
    });
});
