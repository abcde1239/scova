import { describe, expect, it } from 'vite-plus/test';
import type { Report, QuestionAnswer } from '@scova/models';
import { conversationSources, conversationSuggestions } from '@/utils/report/conversation';

describe('report conversation presentation', () => {
    it('groups each webpage once and preserves distinct exact quotes and paragraph provenance', () => {
        const report = {
            title: '报告',
            claims: [],
            limitations: [],
            evidence: [
                {
                    id: 'first',
                    url: 'https://example.com/a',
                    title: '公告',
                    quote: 'saved quote one',
                },
                {
                    id: 'second',
                    url: 'https://example.com/a',
                    title: '公告的另一快照',
                    quote: 'saved quote two',
                },
            ],
        } as unknown as Report;
        const answer = {
            statements: [
                { citations: [{ evidenceId: 'first', quote: 'quote one' }] },
                {
                    citations: [
                        { evidenceId: 'first', quote: 'quote one' },
                        { evidenceId: 'second', quote: 'quote two' },
                    ],
                },
            ],
        } as QuestionAnswer;
        const sources = conversationSources(answer, report);
        expect(sources).toHaveLength(1);
        expect(sources[0]!.citations).toEqual([
            { quote: 'quote one', statements: [1, 2] },
            { quote: 'quote two', statements: [2] },
        ]);
        expect(sources[0]!.evidence).toHaveLength(2);
        expect(sources[0]!.link).toBe('https://example.com/a');
    });
    it('derives suggestions from saved report content and handles reports without limitations', () => {
        const report = {
            title: '申请计划',
            claims: [{ text: '申请按季度开放' }, { text: '需要在线登记' }],
            limitations: ['第二季度日期未公布'],
        } as Report;
        expect(conversationSuggestions(report)).toHaveLength(3);
        expect(conversationSuggestions(report).join()).toContain('第二季度日期未公布');
        expect(
            conversationSuggestions({ ...report, claims: [], limitations: [] }).join(),
        ).toContain('申请计划');
    });
});
