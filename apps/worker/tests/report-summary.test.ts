import { describe, expect, it } from 'vite-plus/test';
import type { AgentClaim } from '@scova/agent-core';
import { reportSummary } from '../src/utils/report-summary.ts';
const claim = (kind: AgentClaim['kind'], text: string): AgentClaim => ({
    kind,
    text,
    questionIds: [],
    citations: [],
});
describe('report overview', () => {
    it('prioritizes synthesized conclusions and keeps verbatim evidence out of the overview', () => {
        expect(
            reportSummary([
                claim('fact', '原文证据。'),
                claim('inference', '提炼后的结论。'),
                claim('inference', '提炼后的结论。'),
            ]),
        ).toBe('提炼后的结论。');
    });
    it('bounds paragraphs without cutting sentences or Unicode characters', () => {
        const sentence = '😀'.repeat(250) + '。';
        expect(
            reportSummary([
                claim('inference', sentence),
                claim('inference', sentence + '结尾。'),
                claim('inference', '继续。'),
            ]),
        ).toBe(`${sentence}\n\n${sentence}结尾。\n\n继续。`);
        expect(reportSummary([claim('inference', '长'.repeat(601))])).toContain('请查看下方');
    });
    it('keeps explicit insufficiency instead of manufacturing a summary', () => {
        expect(reportSummary([claim('insufficient', '未完成内容归纳。')])).toBe('未完成内容归纳。');
    });
});
