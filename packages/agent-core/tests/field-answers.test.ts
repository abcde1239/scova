import { describe, expect, it } from 'vite-plus/test';
import {
    activeFieldClaims,
    mergeFieldClaims,
    pendingFieldClaims,
} from '../src/report/field-answers.ts';
import { fieldSynthesisBatches, isSynthesisOperation } from '../src/research/synthesis-batches.ts';
import type { AgentClaim } from '../src/types.ts';
import type { ReportArtifact } from '@scova/models';

const claim = (text: string): AgentClaim => ({
    text,
    kind: 'inference',
    outputFormat: 'research_report',
    questionIds: ['q0'],
    citations: [{ pageId: 'p0', quote: text }],
});
const artifact = (index: number): ReportArtifact => ({
    format: 'research_report',
    claimIndexes: [index],
    coverage: {
        version: 1,
        requirements: [
            {
                id: 'field',
                object: '',
                field: '使用条件',
                required: true,
                questionIds: ['q0'],
                status: 'supported',
                gap: '',
                claimIndexes: [index],
            },
        ],
    },
});
describe('field answer activity and stable grouping', () => {
    it('keeps validated pending evidence when a draft wins display, without reviving invalid or finished claims', () => {
        const external = claim('合法但尚未完成字段关联的外部命题');
        const artifacts = [artifact(0)];
        artifacts[0]!.coverage!.requirements[0]!.status = 'model_answered';
        const data = {
            claims: [external, claim('未经验证的内容')],
            artifacts: [
                {
                    format: 'research_report',
                    requirements: [{ id: 'field', claimIndexes: [0, 1, 999] }],
                },
            ],
        };
        expect(pendingFieldClaims(data, [external], artifacts)).toEqual([external]);
        artifacts[0]!.coverage!.requirements[0]!.status = 'supported';
        expect(pendingFieldClaims(data, [external], artifacts)).toEqual([]);
    });
    it('does not accumulate previous attempts across repeated field replacement', () => {
        let active: AgentClaim[] = [];
        const history: AgentClaim[] = [];
        for (let attempt = 0; attempt < 60; attempt++) {
            const next = claim(`只有离线且月付时适用，第${attempt}次已验证回答`);
            history.push(next);
            const proposed = mergeFieldClaims(active, [next]);
            active = activeFieldClaims(proposed, [artifact(proposed.length - 1)]);
            expect(active).toEqual([next]);
        }
        expect(history).toHaveLength(60);
        expect(active).toHaveLength(1);
    });
    it('keeps bound conditions, other questions and opposing evidence', () => {
        const conditional = claim('仅企业月付且离线时有效，个人版不支持。');
        const conflict = { ...claim('官方两个版本存在冲突'), kind: 'conflict' as const };
        const other = { ...claim('乙方案仍待核实'), questionIds: ['q1'] };
        expect(
            activeFieldClaims([conditional, claim('重复背景'), conflict, other], [artifact(0)]),
        ).toEqual([conditional, conflict, other]);
    });
    it('keeps question scope separate and resumes stable operation keys beyond batch eight', () => {
        const requirements = Array.from({ length: 12 }, (_, i) => ({
            id: `field${i}`,
            format: 'research_report' as const,
            questionIds: [`q${i}`],
            object: '',
            field: `问题${i}`,
            required: true,
        }));
        const batches = fieldSynthesisBatches(['research_report'], requirements);
        expect(batches).toHaveLength(12);
        expect(batches.every((b) => b.requirements.length === 1)).toBe(true);
        expect(isSynthesisOperation('synthesize-batch-11-3', 4, 60)).toBe(true);
        expect(isSynthesisOperation('synthesize-batch-11-3', 4)).toBe(false);
        expect(isSynthesisOperation('synthesize-batch-60-0', 4, 60)).toBe(false);
    });
});
