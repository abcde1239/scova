import { searchCheckpointResponse } from '../../search/receipt.ts';
import { ConnectorError, normalizeUrl } from '@scova/connectors';
import { type ResearchState, MAX_QUERIES, object, strings, unique, allowed } from '../state.ts';
import type { AgentRuntime } from '../runtime.ts';

export function searchNode(rt: AgentRuntime) {
    const { context, deps, guard } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (state.searchIndex >= state.queries.length) return state;
        if (state.searchIndex >= Math.min(MAX_QUERIES, context.budget.maxSearches)) {
            state.exhausted.push('searches');
            state.gaps.push('搜索预算耗尽');
            state.searchIndex = state.queries.length;
            return state;
        }
        const index = state.searchIndex++;
        try {
            const response = await deps.tools.search(`search-${index}`, state.queries[index].query);
            await guard();
            if (
                response.mode !== context.mode ||
                response.kind !== 'search_results' ||
                !Array.isArray(response.results) ||
                response.results.length > 10 ||
                !object(response.coverage) ||
                !strings(response.coverage.gaps, 1100, 2000)
            )
                throw new ConnectorError('invalid_response', '搜索结果结构或模式不合法');
            // Bodies are durable in the Worker tool ledger; do not duplicate them in every checkpoint.
            state.providerPageUrls = unique([
                ...(state.providerPageUrls ?? []),
                ...response.results.flatMap((result) =>
                    result.page?.kind === 'read_page' &&
                    typeof result.page.text === 'string' &&
                    result.page.text.trim()
                        ? [result.originalUrl, result.url]
                              .filter((url) => typeof url === 'string' && allowed(context, url))
                              .map(normalizeUrl)
                        : [],
                ),
            ]);
            state.searches.push({
                query: state.queries[index],
                response: searchCheckpointResponse(response),
            });
            const localTruncation =
                response.coverage.truncated &&
                !response.coverage.unresponsiveEngines.length &&
                !response.coverage.diagnostics?.skippedEngines.length &&
                response.coverage.gaps.every((gap) => gap === '搜索结果已按调用上限截断');
            if (state.softEvidence && localTruncation)
                state.notes!.push('搜索候选已按调用上限筛选；这不代表搜索引擎故障或互联网穷尽');
            else {
                state.gaps.push(...response.coverage.gaps);
                if (!response.coverage.complete) state.gaps.push('搜索供应商报告覆盖不完整');
            }
        } catch (error) {
            await guard();
            if (!(error instanceof ConnectorError)) throw error;
            if (error instanceof ConnectorError && error.searchNetworkAttempts !== undefined)
                state.failedSearchNetworkAttempts =
                    (state.failedSearchNetworkAttempts ?? 0) + error.searchNetworkAttempts;
            if (error instanceof ConnectorError && error.code === 'budget_exceeded')
                state.searchBlocked = true;
            state.gaps.push(`第 ${index + 1} 次搜索失败，未获得可验证正文`);
        }
        return state;
    };
}
