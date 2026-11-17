import { createHash } from 'node:crypto';
import { PAGE_TEXT_CHAR_LIMIT, validPageCollection } from '@scova/connectors';
import { confirmsRequestedVersion } from '../../search-recovery.ts';
import { AgentError } from '../../types.ts';
import { type ResearchState, MAX_PAGES, allowed } from '../state.ts';
import type { AgentRuntime } from '../runtime.ts';

export function readNode(rt: AgentRuntime) {
    const { context, deps, guard } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (state.readIndex >= state.selections.length) return state;
        if (state.readIndex >= Math.min(MAX_PAGES, context.budget.maxPages)) {
            state.exhausted.push('pages');
            state.gaps.push('正文读取预算耗尽');
            state.readIndex = state.selections.length;
            return state;
        }
        const index = state.readIndex++;
        const selection = state.selections[index];
        try {
            const page = await deps.tools.read(`read-${index}`, selection.url);
            await guard();
            if (
                page.kind !== 'read_page' ||
                page.mode !== context.mode ||
                typeof page.text !== 'string' ||
                !page.text.trim() ||
                page.text.length > PAGE_TEXT_CHAR_LIMIT ||
                typeof page.truncated !== 'boolean' ||
                !validPageCollection(page.collection) ||
                typeof page.title !== 'string' ||
                page.title.length > 2000 ||
                typeof page.url !== 'string' ||
                typeof page.fetchedUrl !== 'string' ||
                page.originalUrl !== selection.url ||
                !allowed(context, page.url) ||
                !allowed(context, page.fetchedUrl) ||
                page.contentHash !== createHash('sha256').update(page.text, 'utf8').digest('hex') ||
                !Number.isFinite(Date.parse(page.collectedAt)) ||
                typeof page.extractionVersion !== 'string' ||
                !page.extractionVersion ||
                page.untrusted !== true
            )
                throw new AgentError('INVALID_OUTPUT', '网页正文来源或指纹校验失败');
            if (page.truncated) state.gaps.push('正文已截断，不能据此前缀判定整页事实与变化');
            const requestedScope = `${context.config.topic} ${context.config.goal} ${context.config.focusPoints.join(' ')}`;
            if (!confirmsRequestedVersion(requestedScope, page))
                state.gaps.push(
                    '已取得正文，但来源版本范围尚未确认，不能作为请求版本或 current 文档的完整覆盖',
                );
            state.pages.push({
                ...page,
                id: `read-${index}`,
                questionIds: selection.questionIds,
            });
        } catch {
            await guard();
            state.gaps.push(`第 ${index + 1} 个来源正文采集失败`);
        }
        return state;
    };
}
