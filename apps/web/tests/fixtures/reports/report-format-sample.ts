import {
    parseContract,
    ReportSchema,
    researchCoverageMetrics,
    type Report,
    type ReportArtifact,
} from '@scova/models';

/** Long synthetic answers for responsive QA; never creates or modifies a saved report. */
export function reportLongFormatSample(format: Report['format']): Report {
    const report = structuredClone(reportFormatSample(format));
    const paragraphs = [
        '这是一份长文排版测试资料。长段落需要同时保留机制、适用条件和例外，不能通过缩小字号、裁切答案或隐藏限定来压缩表格。'.repeat(
            7,
        ),
        '第二段用于检查原始段落是否保持可读。桌面表格按各对象内容分配宽度，屏幕不足时在表格内部滚动；文章正文保持适中的行宽。'.repeat(
            5,
        ),
        `Long identifiers must wrap within their own column: https://example.com/${'long-path-'.repeat(40)}`,
    ].join('\n\n');
    for (const claim of report.claims) claim.text += `\n\n${paragraphs}`;
    for (const artifact of report.coverage.artifacts ?? []) {
        const values = [
            ...(artifact.content?.list?.entries.flatMap((entry) => entry.fields) ?? []),
            ...(artifact.content?.comparison?.cells ?? []),
        ];
        for (const value of values) value.text = report.claims[value.claimIndexes[0]!]!.text;
    }
    report.title = '长文弹性排版 · 虚构资料';
    return parseContract(ReportSchema, report);
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-11-11T03:00:00Z';
const first = '甲馆工作日 09:00–18:00 免费开放，无需预约，持读者证即可使用自习室。';
const second = '乙馆周二至周日 10:00–20:00 免费开放，须在线预约并携带读者证，每次预约最多两小时。';
const texts = [
    '本报告依据两馆开放说明，比较预约方式、开放时段和证件要求。',
    first,
    second,
    '两馆都要求携带读者证，主要差别在于是否需要预约，以及周末能否使用。甲馆工作日免预约，适合临时到馆自习。\n\n乙馆的开放日包含周末，但需要提前在线预约。每次预约最多两小时，安排较长的自习时段时需要留意这一限制。',
    '工作日临时自习可选择免预约的甲馆；周末自习可提前预约乙馆，并按每次两小时安排使用时间。',
    '两馆自习室均免费开放，入馆需携带读者证。',
    '两馆自习室均免费开放，入馆都需读者证。工作日临时到馆可选免预约的甲馆；需要周末自习时，可提前预约乙馆，每次最多两小时。',
];
const value = (text: string, claimIndex: number) => ({
    text,
    claimIndexes: [claimIndex],
    status: 'supported' as const,
    gap: '',
});
const fields = (secondLibrary: boolean) => [
    {
        id: 'reservation',
        label: '预约方式',
        ...value(
            secondLibrary ? '须在线预约并携带读者证，每次预约最多两小时' : '无需预约',
            secondLibrary ? 2 : 1,
        ),
    },
    {
        id: 'hours',
        label: '开放时段',
        ...value(
            secondLibrary ? '周二至周日 10:00–20:00' : '工作日 09:00–18:00',
            secondLibrary ? 2 : 1,
        ),
    },
    { id: 'card', label: '携带物品', ...value('读者证', 5) },
    { id: 'fee', label: '费用', ...value('免费', 5) },
];
const summary = '甲馆工作日免预约；乙馆可预约周末时段，每次最多两小时。两馆均需读者证。';
const artifacts: ReportArtifact[] = [
    {
        format: 'brief',
        claimIndexes: [1, 2, 4, 5],
        summary: '甲馆工作日免预约；乙馆可预约周末时段，每次最多两小时。两馆均需读者证。',
        content: {
            version: 1,
            document: {
                version: 1,
                sections: [
                    {
                        id: 'findings',
                        title: '两馆预约要求不同，均需读者证',
                        role: 'key_findings',
                        claimIndexes: [1, 2],
                    },
                    { id: 'choice', title: '如何选择', role: 'conclusion', claimIndexes: [4] },
                ],
            },
        },
    },
    {
        format: 'list',
        claimIndexes: [1, 2, 4, 5],
        summary,
        content: {
            version: 1,
            list: {
                entries: [
                    { id: 'a', name: '甲馆', fields: fields(false) },
                    { id: 'b', name: '乙馆', fields: fields(true) },
                ],
            },
        },
    },
    {
        format: 'comparison',
        claimIndexes: [1, 2, 4, 5],
        summary: '甲馆工作日免预约；乙馆可预约周末时段，每次最多两小时。两馆均需读者证。',
        content: {
            version: 1,
            comparison: {
                objects: [
                    { id: 'a', name: '甲馆' },
                    { id: 'b', name: '乙馆' },
                ],
                dimensions: fields(false).map(({ id: fieldId, label }) => ({ id: fieldId, label })),
                cells: [false, true].flatMap((isSecond) =>
                    fields(isSecond).map(({ id: dimensionId, label: _label, ...field }) => ({
                        objectId: isSecond ? 'b' : 'a',
                        dimensionId,
                        ...field,
                    })),
                ),
            },
        },
    },
    {
        format: 'research_report',
        claimIndexes: [0, 1, 2, 3, 4, 5],
        summary,
        content: {
            version: 1,
            document: {
                version: 1,
                sections: [
                    { id: 'overview', title: '摘要', role: 'overview', claimIndexes: [6] },
                    { id: 'scope', title: '范围与资料依据', role: 'context', claimIndexes: [0] },
                    {
                        id: 'arrangements',
                        title: '预约与开放安排',
                        role: 'key_findings',
                        claimIndexes: [1, 2],
                    },
                    {
                        id: 'discussion',
                        title: '使用情境与主要差异',
                        role: 'analysis',
                        claimIndexes: [3],
                    },
                    {
                        id: 'conclusion',
                        title: '结论与使用建议',
                        role: 'conclusion',
                        claimIndexes: [4],
                    },
                ],
            },
        },
    },
];

/** Synthetic evidence, shared across the four saved artifacts. Never represents a live run. */
export function reportFormatSample(format: Report['format'] = 'brief'): Report {
    const artifact = artifacts.find((entry) => entry.format === format)!;
    const main = artifact.content?.document?.sections.flatMap(
        (section) => section.claimIndexes,
    ) ?? [1, 2, 4, 5];
    const report = parseContract(ReportSchema, {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '两馆自习室使用条件',
        summary,
        format,
        mode: 'demo',
        outcome: 'baseline',
        publishedAt: time,
        coverage: {
            completeness: 'complete',
            searchedQueries: ['虚构样例：两馆预约与开放说明'],
            gaps: [],
            exhausted: [],
            artifacts: [{ ...artifact, claimIndexes: texts.map((_, index) => index) }],
            reportValue: {
                version: 1,
                researchMode: 'collection',
                questions: [
                    {
                        id: 'arrangements',
                        text: '预约、开放时间和证件有何要求？',
                        priority: 'core',
                        status: 'supported',
                        claimIndexes: main.filter((index) => index < 3),
                        gap: '',
                    },
                    {
                        id: 'differences',
                        text: '两馆的使用条件有哪些差异？',
                        priority: 'core',
                        status: 'supported',
                        claimIndexes: main.filter((index) => index >= 3),
                        gap: '',
                    },
                    {
                        id: 'fees',
                        text: '费用与入馆证件有何要求？',
                        priority: 'supporting',
                        status: 'supported',
                        claimIndexes: main.filter((index) => [1, 2, 5, 6].includes(index)),
                        gap: '',
                    },
                ],
                selections: texts.map((_, claimIndex) => ({
                    claimIndex,
                    questionIds: main.includes(claimIndex)
                        ? [
                              ...(claimIndex < 3 ? ['arrangements'] : ['differences']),
                              ...([1, 2, 5, 6].includes(claimIndex) ? ['fees'] : []),
                          ]
                        : [],
                    placement: main.includes(claimIndex) ? 'main' : 'omitted',
                    reason: '虚构证据集的保存判断',
                    basis: 'model_assessment',
                    timeScope: 'unknown',
                    assessment: {
                        relevance: 'direct',
                        support: 'direct',
                        role: 'answer',
                        sourceRelation: 'original',
                        reason: '逐项核对两份虚构开放说明。',
                        conditions: claimIndex === 2 ? '每次预约最多两小时' : '',
                        gap: '',
                    },
                })),
            },
        },
        limitations: [],
        claims: texts.map((text, index) => ({
            id: id(10 + index),
            kind: [1, 2, 5].includes(index) ? 'fact' : 'inference',
            text,
            confidenceLabel: '依据本页两份虚构来源说明',
            evidenceIds: index === 1 ? [id(20)] : index === 2 ? [id(21)] : [id(20), id(21)],
        })),
        evidence: [first, second].map((quote, index) => ({
            id: id(20 + index),
            sourceId: id(100 + index),
            snapshotId: id(200 + index),
            title: `${index ? '乙' : '甲'}馆开放说明（虚构）`,
            url: `https://example.test/library-${index ? 'b' : 'a'}`,
            quote,
            location: '示例开放说明第 1 段',
            observedAt: time,
        })),
        changes: [],
    });
    report.coverage.metrics = researchCoverageMetrics(
        report.coverage.reportValue,
        report.claims,
        report.coverage.artifacts,
    );
    return parseContract(ReportSchema, report);
}
