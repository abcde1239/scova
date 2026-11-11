import { describe, expect, it } from 'vite-plus/test';
import {
    classifyReportDelivery,
    parseContract,
    ReportDeliverySchema,
    type ReportValue,
    type ReportArtifact,
} from '../src/index.ts';

function value(status = 'provisional', priority = 'core'): ReportValue {
    return {
        version: 1,
        questions: [
            {
                id: 'q0',
                text: '核心问题',
                priority,
                status,
                claimIndexes: [0],
                gap: '时间尚未确认',
            },
            {
                id: 'q1',
                text: '补充问题',
                priority: 'supporting',
                status: 'unresolved',
                claimIndexes: [],
                gap: '未覆盖',
            },
        ],
        selections: [
            {
                claimIndex: 0,
                questionIds: ['q0'],
                placement: 'main',
                reason: '直接回答',
                basis: 'model_assessment',
                timeScope: 'unknown',
                assessment: {
                    relevance: 'direct',
                    support: 'partial',
                    role: 'answer',
                    sourceRelation: 'unknown',
                    reason: '条件内有材料基础',
                    conditions: '仅适用于现有版本',
                    gap: '',
                },
            },
        ],
    } as ReportValue;
}
describe('content delivery independent from complete monitoring', () => {
    it.each(['provisional', 'disputed', 'supported'])(
        'delivers a cited %s core answer despite unknown dates or missing supporting questions',
        (status) => {
            expect(
                parseContract(
                    ReportDeliverySchema,
                    classifyReportDelivery(value(status), [{ kind: 'inference' }]),
                ),
            ).toMatchObject({
                status: 'answered',
                answeredQuestions: 1,
                questionCount: 2,
                answeredCoreQuestions: 1,
                coreQuestionCount: 1,
            });
        },
    );
    it('does not present uncertain snippets or unrelated material as answers', () => {
        expect(classifyReportDelivery(value(), [{ kind: 'insufficient' }]).status).toBe(
            'sources_only',
        );
        const data = value();
        data.selections[0].placement = 'reference';
        expect(classifyReportDelivery(data, [{ kind: 'fact' }]).status).toBe('sources_only');
    });
    it('distinguishes a useful supporting answer from an unanswered core', () => {
        const data = value();
        data.questions[0].priority = 'supporting';
        data.questions[1].priority = 'core';
        expect(
            parseContract(ReportDeliverySchema, classifyReportDelivery(data, [{ kind: 'fact' }]))
                .status,
        ).toBe('partial');
    });
    it('does not claim completion with no question mapping', () => {
        expect(classifyReportDelivery(undefined, [{ kind: 'fact' }]).status).toBe('sources_only');
    });
    it('rejects impossible delivery counts', () => {
        const data = classifyReportDelivery(value(), [{ kind: 'fact' }]);
        expect(() =>
            parseContract(ReportDeliverySchema, { ...data, answeredCoreQuestions: 0 }),
        ).toThrow();
    });
    it('does not count a partially covered object collection as a fully answered core question', () => {
        const artifact: ReportArtifact = {
            format: 'list',
            claimIndexes: [0, 1],
            coverage: {
                version: 1,
                requirements: [
                    {
                        id: 'pathlib',
                        object: 'pathlib',
                        field: '用途',
                        questionIds: ['q0'],
                        required: true,
                        status: 'supported',
                        claimIndexes: [0],
                        gap: '',
                    },
                    {
                        id: 'datetime',
                        object: 'datetime',
                        field: '用途',
                        questionIds: ['q0'],
                        required: true,
                        status: 'unknown',
                        claimIndexes: [],
                        gap: '正文未取得，不能核实用途',
                    },
                ],
            },
        };
        const result = classifyReportDelivery(
            value(),
            [{ kind: 'inference' }, { kind: 'insufficient' }],
            [artifact],
        );
        expect(parseContract(ReportDeliverySchema, result)).toMatchObject({
            status: 'partial',
            answeredCoreQuestions: 0,
            answeredQuestions: 0,
        });
        artifact.coverage!.requirements[1] = {
            ...artifact.coverage!.requirements[1]!,
            status: 'supported',
            claimIndexes: [1],
            gap: '',
        };
        expect(
            classifyReportDelivery(
                value(),
                [{ kind: 'inference' }, { kind: 'inference' }],
                [artifact],
            ).status,
        ).toBe('answered');
    });
    it('checks every selected artifact and rejects insufficient requirements promoted to supported', () => {
        const requirement = {
            id: 'r',
            object: '对象',
            field: '请求字段',
            questionIds: ['q0'],
            required: true,
            status: 'supported' as const,
            claimIndexes: [0],
            gap: '',
        };
        const artifacts: ReportArtifact[] = [
            {
                format: 'brief',
                claimIndexes: [0],
                coverage: { version: 1, requirements: [requirement] },
            },
            {
                format: 'comparison',
                claimIndexes: [1],
                coverage: { version: 1, requirements: [{ ...requirement, claimIndexes: [1] }] },
            },
        ];
        expect(
            classifyReportDelivery(
                value(),
                [{ kind: 'inference' }, { kind: 'insufficient' }],
                artifacts,
            ).status,
        ).toBe('partial');
    });
});
