import { describe, expect, it } from 'vite-plus/test';
import {
    ReportValueSchema,
    parseContract,
    validReportValueClaims,
    type ReportValue,
} from '../src/index.ts';

const fixture = (): ReportValue => ({
    version: 1,
    questions: [
        {
            id: 'q0',
            text: '原始问题',
            priority: 'core',
            status: 'unresolved',
            claimIndexes: [],
            gap: '未获得直接支持',
        },
    ],
    selections: [
        {
            claimIndex: 0,
            questionIds: ['q0'],
            placement: 'reference',
            reason: '评估缺失',
            basis: 'unassessed',
            timeScope: 'unknown',
        },
    ],
});
describe('versioned question/answer contract', () => {
    it('binds selections to the complete claim order', () => {
        const value = parseContract(ReportValueSchema, fixture());
        expect(validReportValueClaims(value, 1)).toBe(true);
        expect(validReportValueClaims(value, 2)).toBe(false);
        value.selections[0].claimIndex = 2;
        expect(validReportValueClaims(value, 1)).toBe(false);
    });
    it.each([
        'duplicate_question',
        'foreign_question',
        'unsupported_main',
        'missing_answer',
        'forged_status',
    ])('rejects invalid linkage: %s', (kind) => {
        const value = fixture();
        if (kind === 'duplicate_question') value.questions.push({ ...value.questions[0] });
        if (kind === 'foreign_question') value.selections[0].questionIds = ['foreign'];
        if (kind === 'unsupported_main') value.selections[0].placement = 'main';
        if (kind === 'missing_answer') value.questions[0].status = 'provisional';
        if (kind === 'forged_status') {
            value.questions[0].status = 'supported';
            value.questions[0].claimIndexes = [0];
        }
        expect(() => parseContract(ReportValueSchema, value)).toThrow();
    });
});
