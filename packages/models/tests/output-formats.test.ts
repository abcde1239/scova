import { describe, expect, it } from 'vite-plus/test';
import {
    OutputFormatsSchema,
    RunCommandInputSchema,
    selectedOutputFormats,
    parseContract,
    ReportSchema,
    type Report,
} from '../src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function savedReport(): Report {
    return {
        id: id(1),
        runId: id(2),
        taskId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '交付成果',
        summary: '简报结论',
        format: 'brief',
        mode: 'live',
        outcome: 'inconclusive',
        publishedAt: '2026-11-10T00:00:00Z',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['用户问题'],
            gaps: ['未覆盖全部资料'],
            exhausted: [],
            artifacts: [
                { format: 'brief', claimIndexes: [0] },
                { format: 'comparison', claimIndexes: [1] },
            ],
        },
        limitations: ['未覆盖全部资料'],
        claims: [
            {
                id: id(10),
                kind: 'inference',
                text: '简报核心答案',
                confidenceLabel: '来源归纳',
                evidenceIds: [id(20)],
            },
            {
                id: id(11),
                kind: 'inference',
                text: '两对象按同口径比较',
                confidenceLabel: '来源归纳',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(21),
                snapshotId: id(22),
                title: '原始资料',
                url: 'https://example.com/source',
                quote: '资料原文。',
                location: '正文',
                observedAt: '2026-11-10T00:00:00Z',
            },
        ],
        changes: [],
    };
}

describe('frozen output selections and artifact ownership', () => {
    it('keeps legacy single-format versions and copies new multi-selections', () => {
        expect(selectedOutputFormats({ outputFormat: 'list' })).toEqual(['list']);
        const config = {
            outputFormat: 'brief' as const,
            outputFormats: ['comparison', 'research_report'] as (
                | 'comparison'
                | 'research_report'
            )[],
        };
        const selected = selectedOutputFormats(config);
        expect(selected).toEqual(['comparison', 'research_report']);
        selected.reverse();
        expect(config.outputFormats).toEqual(['comparison', 'research_report']);
    });

    it.each(
        [
            [],
            ['brief', 'brief'],
            ['markdown'],
            ['brief', 'list', 'comparison', 'research_report', 'brief'],
        ].map((formats) => [formats]),
    )('rejects empty, duplicate, unknown or excessive selections: %j', (formats) => {
        expect(() => parseContract(OutputFormatsSchema, formats)).toThrow();
        expect(() => parseContract(RunCommandInputSchema, { outputFormats: formats })).toThrow();
    });

    it('accepts explicit multiple outputs and historic commands', () => {
        expect(() =>
            parseContract(RunCommandInputSchema, {
                outputFormat: 'brief',
                outputFormats: ['list'],
            }),
        ).toThrow();
        expect(
            parseContract(RunCommandInputSchema, { outputFormats: ['brief', 'comparison'] })
                .outputFormats,
        ).toEqual(['brief', 'comparison']);
        expect(parseContract(RunCommandInputSchema, {})).toEqual({});
        expect(parseContract(ReportSchema, savedReport()).coverage.artifacts).toHaveLength(2);
        const legacy = savedReport();
        delete legacy.coverage.artifacts;
        expect(parseContract(ReportSchema, legacy).format).toBe('brief');
    });

    it.each([
        'duplicate_format',
        'foreign_index',
        'shared_claim',
        'missing_primary',
        'primary_not_first',
        'unassigned_claim',
        'duplicate_index',
    ])('rejects damaged artifact mapping: %s', (kind) => {
        const report = savedReport();
        const artifacts = report.coverage.artifacts!;
        if (kind === 'duplicate_format') artifacts[1].format = 'brief';
        if (kind === 'foreign_index') artifacts[1].claimIndexes = [2];
        if (kind === 'shared_claim') artifacts[1].claimIndexes = [0];
        if (kind === 'missing_primary') report.format = 'list';
        if (kind === 'primary_not_first') report.format = 'comparison';
        if (kind === 'unassigned_claim') artifacts[1].claimIndexes = [];
        if (kind === 'duplicate_index') artifacts[0].claimIndexes = [0, 0];
        expect(() => parseContract(ReportSchema, report)).toThrow();
    });
});
