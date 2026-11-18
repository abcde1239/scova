import { describe, expect, it } from 'vite-plus/test';
import {
    parseContract,
    ReportArtifactSchema,
    validReportArtifacts,
    type ReportValue,
} from '@scova/models';
import { buildArtifactDocument, artifactSynthesisSchema } from '../src/report/artifacts/index.ts';
import type { AgentClaim, ComparisonExtraction } from '../src/types.ts';

const assessment = {
    relevance: 'direct',
    support: 'direct',
    role: 'answer',
    sourceRelation: 'original',
    reason: '依据支持',
    conditions: '按年付费',
    gap: '',
} as const;
function fixture() {
    const claims: AgentClaim[] = [
        '甲方案按年付费时折合每月20元。',
        '乙方案限在线使用。',
        '还没有核实收费时间。',
    ].map((text, index) => ({
        kind: index === 2 ? 'insufficient' : 'inference',
        text,
        outputFormat: 'research_report',
        questionIds: ['q0'],
        citations: index === 2 ? [] : [{ pageId: 'p0', quote: text }],
        assessment,
    }));
    const value: ReportValue = {
        version: 1,
        timeless: true,
        questions: [
            {
                id: 'q0',
                text: '费用与适用条件',
                status: 'provisional',
                priority: 'core',
                claimIndexes: [0, 1],
                gap: '收费时间未核实',
            },
        ],
        selections: claims.map((_claim, claimIndex) => ({
            claimIndex,
            questionIds: ['q0'],
            placement: claimIndex === 2 ? 'reference' : 'main',
            reason: '已验证',
            basis: 'model_assessment',
            timeScope: 'unknown',
            assessment,
        })),
    };
    const receipt = (
        local: AgentClaim[],
        sections: unknown[],
        operationKey = 'synthesize-0',
    ): ComparisonExtraction => ({
        operationKey,
        response: {
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: {
                claims: local,
                artifacts: [
                    {
                        format: 'research_report',
                        requirements: [],
                        document: { version: 1, sections },
                    },
                ],
            },
        },
    });
    const section = (id: string, claimIndexes: number[]) => ({
        id,
        title: '费用与适用范围',
        role: 'analysis',
        claimIndexes,
    });
    const checked = (raw: unknown) => raw as AgentClaim;
    return { claims, value, receipt, section, checked };
}

describe('receipt-backed editorial documents', () => {
    it('maps local paragraph order to global owned main indexes without changing claims, conditions or coverage', () => {
        const f = fixture();
        const before = structuredClone({ claims: f.claims, value: f.value });
        const document = buildArtifactDocument(
            'research_report',
            f.claims,
            f.value,
            [f.receipt([f.claims[1]!, f.claims[0]!], [f.section('findings', [1, 0])])],
            f.checked,
        )!;
        expect(document.sections[0]!.claimIndexes).toEqual([0, 1]);
        const artifact = parseContract(ReportArtifactSchema, {
            format: 'research_report',
            claimIndexes: [0, 1, 2],
            content: { version: 1, document },
        });
        expect(validReportArtifacts([artifact], f.claims, f.value)).toBe(true);
        expect(f.claims).toEqual(before.claims);
        expect(f.value).toEqual(before.value);
    });
    it('never hides valid paragraphs omitted by a partial outline or repeats a claim after repair', () => {
        const f = fixture();
        const old = f.receipt(f.claims, [f.section('findings', [0, 1])]);
        const repaired = f.receipt([f.claims[1]!], [f.section('findings', [0])], 'synthesize-1');
        const doc = buildArtifactDocument(
            'research_report',
            f.claims,
            f.value,
            [old, repaired],
            f.checked,
        )!;
        expect(doc.sections[0]!.claimIndexes).toEqual([1]);
        expect(doc.sections.at(-1)).toMatchObject({ title: '补充发现', claimIndexes: [0] });
        expect(doc.sections.flatMap((s) => s.claimIndexes).sort((a, b) => a - b)).toEqual([0, 1]);
    });
    it.each([false, true])(
        'deduplicates identical local claims mapped to one global paragraph (separate sections=%s)',
        (separate) => {
            const f = fixture();
            const doc = buildArtifactDocument(
                'research_report',
                f.claims,
                f.value,
                [
                    f.receipt(
                        [f.claims[0]!, f.claims[0]!],
                        separate
                            ? [f.section('first', [0]), f.section('second', [1])]
                            : [f.section('first', [0, 1])],
                    ),
                ],
                f.checked,
            )!;
            expect(doc.sections.flatMap((section) => section.claimIndexes)).toEqual([0, 1]);
            expect(
                validReportArtifacts(
                    [
                        {
                            format: 'research_report',
                            claimIndexes: [0, 1, 2],
                            content: { version: 1, document: doc },
                        },
                    ],
                    f.claims,
                    f.value,
                ),
            ).toBe(true);
        },
    );
    it('filters reference, insufficient and demoted paragraphs from main prose while retaining other valid content', () => {
        const f = fixture();
        f.value.selections[1]!.placement = 'reference';
        const doc = buildArtifactDocument(
            'research_report',
            f.claims,
            f.value,
            [f.receipt(f.claims, [f.section('findings', [0, 1, 2])])],
            f.checked,
        )!;
        expect(doc.sections.flatMap((s) => s.claimIndexes)).toEqual([0]);
        expect(f.value.questions[0]!.status).toBe('provisional');
    });
    it.each(['foreign', 'duplicate-index', 'duplicate-id', 'forged-claim', 'wrong-format'])(
        'rejects %s document provenance without changing legacy output',
        (kind) => {
            const f = fixture();
            const local = structuredClone(f.claims);
            const sections = [f.section('findings', [0])];
            if (kind === 'foreign') sections[0]!.claimIndexes = [99];
            if (kind === 'duplicate-index') sections[0]!.claimIndexes = [0, 0];
            if (kind === 'duplicate-id') sections.push(f.section('findings', [1]));
            if (kind === 'forged-claim') local[0]!.text = '甲方案永久免费。';
            const receipt = f.receipt(local, sections);
            if (kind === 'wrong-format')
                (
                    receipt.response.data as { artifacts: { format: string }[] }
                ).artifacts[0]!.format = 'brief';
            expect(
                buildArtifactDocument('research_report', f.claims, f.value, [receipt], f.checked),
            ).toBeUndefined();
        },
    );
    it('keeps old receipts and list/comparison compatible, with nullable strict generation document', () => {
        const f = fixture();
        expect(
            buildArtifactDocument('research_report', f.claims, f.value, [], f.checked),
        ).toBeUndefined();
        expect(
            buildArtifactDocument(
                'comparison',
                f.claims,
                f.value,
                [f.receipt(f.claims, [f.section('a', [0])])],
                f.checked,
            ),
        ).toBeUndefined();
        const schema = artifactSynthesisSchema(['brief', 'research_report']);
        expect(schema.items.required).toContain('document');
        expect(schema.items.properties.document.anyOf).toContainEqual({ type: 'null' });
    });
    it('keeps a verified abstract in the saved document without duplicating its body indexes', () => {
        const f = fixture();
        const section = { ...f.section('abstract', [0]), role: 'overview' };
        const doc = buildArtifactDocument(
            'research_report',
            f.claims,
            f.value,
            [f.receipt(f.claims, [section, f.section('analysis', [1])])],
            f.checked,
        )!;
        expect(doc.sections.map((entry) => entry.role)).toEqual(['overview', 'analysis']);
        expect(doc.sections.flatMap((entry) => entry.claimIndexes)).toEqual([0, 1]);
    });
});
