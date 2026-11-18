import { describe, expect, it } from 'vite-plus/test';
import { validReportArtifacts } from '../src/report/artifact-validation.ts';
import type { ReportArtifact } from '../src/report/artifacts.ts';

function fixture() {
    const claims = [
        { kind: 'inference', text: 'A 对象需要事务重试。' },
        { kind: 'inference', text: 'B 对象保持固定快照。' },
    ];
    const artifact: ReportArtifact = {
        format: 'comparison',
        claimIndexes: [0, 1],
        content: {
            version: 1,
            comparison: {
                objects: [
                    { id: 'a', name: 'A' },
                    { id: 'b', name: 'B' },
                ],
                dimensions: [{ id: 'scope', label: '适用条件' }],
                cells: [
                    {
                        objectId: 'a',
                        dimensionId: 'scope',
                        text: 'A 对象需要事务重试。',
                        claimIndexes: [0],
                        status: 'supported',
                        gap: '',
                    },
                    {
                        objectId: 'b',
                        dimensionId: 'scope',
                        text: 'B 对象保持固定快照。',
                        claimIndexes: [1],
                        status: 'supported',
                        gap: '',
                    },
                ],
            },
        },
    };
    return { claims, artifact };
}
describe('saved structured artifact provenance', () => {
    it('accepts complete explicit object cells bound to their own verified claims', () => {
        const { claims, artifact } = fixture();
        expect(validReportArtifacts([artifact], claims)).toBe(true);
        expect(validReportArtifacts(undefined, claims)).toBe(true);
    });
    it.each([
        'fabricated-value',
        'foreign-index',
        'insufficient',
        'missing-cell',
        'duplicate-cell',
        'unknown-object',
    ])('rejects %s in a saved comparison', (kind) => {
        const { claims, artifact } = fixture();
        const matrix = artifact.content!.comparison!;
        if (kind === 'fabricated-value') matrix.cells[0]!.text = 'A 对象不需要事务重试。';
        if (kind === 'foreign-index') artifact.claimIndexes = [1];
        if (kind === 'insufficient') claims[0]!.kind = 'insufficient';
        if (kind === 'missing-cell') matrix.cells.pop();
        if (kind === 'duplicate-cell') matrix.cells[1] = { ...matrix.cells[0]! };
        if (kind === 'unknown-object') matrix.cells[0]!.objectId = 'not-planned';
        expect(validReportArtifacts([artifact], claims)).toBe(false);
    });
    it('represents missing required fields as explicit unknown cells without invented values', () => {
        const { claims, artifact } = fixture();
        artifact.content!.comparison!.cells[1] = {
            objectId: 'b',
            dimensionId: 'scope',
            text: '',
            claimIndexes: [],
            status: 'unknown',
            gap: 'B 的对应正文未取得',
        };
        expect(validReportArtifacts([artifact], claims)).toBe(true);
        artifact.content!.comparison!.cells[1]!.text = '免费';
        expect(validReportArtifacts([artifact], claims)).toBe(false);
    });
});
