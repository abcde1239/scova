import { evidenceExcerpt } from '../../model/input.ts';
import { type AgentClaim } from '../../types.ts';
import { type ResearchState } from '../state.ts';

export function deterministicClaims(state: ResearchState): AgentClaim[] {
    if (state.mode === 'live') {
        const claims: AgentClaim[] = [];
        for (let index = 0; index < state.pages.length; index += 10) {
            claims.push({
                kind: 'insufficient',
                text: '已保存来源证据，但未完成内容归纳与查证。以下引用仅为原文摘录，请查看来源原文或重新执行。',
                citations: state.pages.slice(index, index + 10).map((page) => ({
                    pageId: page.id,
                    quote: evidenceExcerpt(page.text),
                })),
                questionIds: [],
            });
        }
        if (!claims.length && state.collectionPolicy)
            claims.push({
                kind: 'insufficient',
                text: '未采集到日期在窗口内且有直接原文出处的资料。',
                citations: [],
                questionIds: [],
            });
        return claims;
    }
    return state.pages.map((page) => {
        const quote = evidenceExcerpt(page.text);
        return {
            kind: 'fact',
            text: quote,
            citations: [{ pageId: page.id, quote }],
            questionIds: [],
        };
    });
}
