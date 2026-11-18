import { describe, expect, it } from 'vite-plus/test';
import { parseContract } from '../src/common/validation.ts';
import { ReportArtifactSchema, type ReportArtifact } from '../src/report/artifacts.ts';
import { validReportArtifacts } from '../src/report/artifact-validation.ts';
import type { ReportValue } from '../src/report/value.ts';

function fixture() {
    const claims = [
        { kind: 'inference', text: '甲按年支付时每月20元。' },
        { kind: 'insufficient', text: '乙价格尚未核实。' },
    ];
    const value: ReportValue = {
        version: 1,
        timeless: true,
        questions: [
            {
                id: 'q0',
                text: '价格',
                priority: 'core',
                status: 'provisional',
                claimIndexes: [0],
                gap: '乙未核实',
            },
        ],
        selections: claims.map((_claim, claimIndex) => ({
            claimIndex,
            questionIds: ['q0'],
            placement: claimIndex ? 'reference' : 'main',
            reason: '证据支持',
            basis: 'model_assessment',
            timeScope: 'unknown',
        })),
    };
    const artifact: ReportArtifact = {
        format: 'brief',
        claimIndexes: [0, 1],
        content: {
            version: 1,
            document: {
                version: 1,
                sections: [
                    {
                        id: 'findings',
                        title: '价格与条件',
                        role: 'key_findings',
                        claimIndexes: [0],
                    },
                ],
            },
        },
    };
    return { claims, value, artifact };
}
describe('saved editorial document contract', () => {
    it('accepts a saved outline without changing partial question coverage', () => {
        const f = fixture();
        expect(parseContract(ReportArtifactSchema, f.artifact)).toEqual(f.artifact);
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(true);
        expect(f.value.questions[0]!.status).toBe('provisional');
        expect(validReportArtifacts([f.artifact], f.claims)).toBe(false);
    });
    it.each([
        'foreign',
        'reference',
        'insufficient',
        'missing-main',
        'duplicate-claim',
        'duplicate-id',
    ])('rejects %s in a document without weakening legacy content', (kind) => {
        const f = fixture();
        const doc = f.artifact.content!.document!;
        if (kind === 'foreign') doc.sections[0]!.claimIndexes = [90];
        if (kind === 'reference') f.value.selections[0]!.placement = 'reference';
        if (kind === 'insufficient') doc.sections[0]!.claimIndexes = [1];
        if (kind === 'missing-main') {
            f.claims[1]!.kind = 'inference';
            f.value.selections[1]!.placement = 'main';
        }
        if (kind === 'duplicate-claim') doc.sections.push({ ...doc.sections[0]!, id: 'other' });
        if (kind === 'duplicate-id') doc.sections.push({ ...doc.sections[0]!, claimIndexes: [1] });
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(false);
    });
    it('retains historical artifact compatibility when no document is stored', () => {
        const f = fixture();
        delete f.artifact.content;
        expect(validReportArtifacts([f.artifact], f.claims)).toBe(true);
        expect(parseContract(ReportArtifactSchema, f.artifact)).toEqual(f.artifact);
    });
});

function structured() {
    const claims = [
        { kind: 'fact', text: '甲采用 Apache-2.0 许可。' },
        { kind: 'fact', text: '乙采用 MIT 许可。' },
        { kind: 'inference', text: '两者都允许商用，差别在专利条款。' },
    ];
    const value: ReportValue = {
        version: 1,
        timeless: true,
        questions: [
            {
                id: 'q0',
                text: '许可',
                priority: 'core',
                status: 'supported',
                claimIndexes: [0, 1, 2],
                gap: '',
            },
        ],
        selections: claims.map((_claim, claimIndex) => ({
            claimIndex,
            questionIds: ['q0'],
            placement: 'main',
            reason: '证据支持',
            basis: 'model_assessment',
            timeScope: 'unknown',
        })),
    };
    const cell = (objectId: string, text: string, index: number) => ({
        objectId,
        dimensionId: 'd0',
        text,
        claimIndexes: [index],
        status: 'supported' as const,
        gap: '',
    });
    const artifact: ReportArtifact = {
        format: 'comparison',
        claimIndexes: [0, 1, 2],
        content: {
            version: 1,
            comparison: {
                objects: [
                    { id: 'o0', name: '甲' },
                    { id: 'o1', name: '乙' },
                ],
                dimensions: [{ id: 'd0', label: '开源许可', group: '基础信息' }],
                cells: [cell('o0', 'Apache-2.0', 0), cell('o1', 'MIT', 1)],
            },
            document: {
                version: 1,
                sections: [{ id: 'core', title: '核心差异', role: 'overview', claimIndexes: [2] }],
            },
        },
    };
    return { claims, value, artifact };
}

describe('structured artifact synthesis outline', () => {
    it('reads the historical full-main outline without accepting a mixed partial outline', () => {
        const f = structured();
        f.artifact.content!.document!.sections[0]!.claimIndexes = [2, 0, 1];
        const before = structuredClone(f);
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(true);
        expect(f).toEqual(before);
        f.artifact.content!.document!.sections[0]!.claimIndexes = [2, 0];
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(false);
        f.artifact.content!.document!.sections[0]!.claimIndexes = [2, 0, 1, 1];
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(false);
        f.value.selections[1]!.placement = 'reference';
        f.artifact.content!.document!.sections[0]!.claimIndexes = [2, 0, 1];
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(false);
    });
    it('accepts a comparison outline covering exactly the unbound synthesis claims', () => {
        const f = structured();
        expect(parseContract(ReportArtifactSchema, f.artifact)).toEqual(f.artifact);
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(true);
    });
    it('accepts a list outline and optional entry groups', () => {
        const f = structured();
        const cells = f.artifact.content!.comparison!.cells;
        f.artifact.format = 'list';
        f.artifact.content = {
            version: 1,
            list: {
                entries: cells.map((c, i) => ({
                    id: c.objectId,
                    name: i ? '乙' : '甲',
                    group: '开源',
                    fields: [{ id: `f${i}`, label: '开源许可', ...c }].map(
                        ({ objectId: _o, dimensionId: _d, ...field }) => field,
                    ),
                })),
            },
            document: f.artifact.content!.document,
        };
        expect(parseContract(ReportArtifactSchema, f.artifact)).toEqual(f.artifact);
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(true);
    });
    it('rejects an outline that repeats a claim already shown in a cell', () => {
        const f = structured();
        f.artifact.content!.document!.sections[0]!.claimIndexes = [0, 2];
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(false);
    });
    it('rejects an outline that omits an unbound synthesis claim', () => {
        const f = structured();
        f.artifact.content!.document!.sections[0]!.claimIndexes = [];
        f.artifact.content!.document!.sections.push({
            id: 'other',
            title: '口径',
            role: 'limitations',
            claimIndexes: [0],
        });
        f.artifact.content!.document!.sections.shift();
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(false);
    });
    it('requires report value for any outline and keeps structured content without one valid', () => {
        const f = structured();
        expect(validReportArtifacts([f.artifact], f.claims)).toBe(false);
        delete f.artifact.content!.document;
        expect(validReportArtifacts([f.artifact], f.claims, f.value)).toBe(true);
    });
    it('rejects blank or overlong groups', () => {
        const f = structured();
        f.artifact.content!.comparison!.dimensions[0]!.group = ' ';
        expect(() => parseContract(ReportArtifactSchema, f.artifact)).toThrow();
        f.artifact.content!.comparison!.dimensions[0]!.group = '组'.repeat(41);
        expect(() => parseContract(ReportArtifactSchema, f.artifact)).toThrow();
    });
});
