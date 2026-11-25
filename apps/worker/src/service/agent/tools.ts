import {
    comparisonSourceCoverage,
    type AgentModelResponse,
    type AgentTools,
    type AgentModelInput,
} from '@scova/agent-core';
import {
    ConnectorError,
    estimateModelInputTokens,
    normalizeUrl,
    searchLanguage,
    type ReadPage,
    type SearchResponse,
} from '@scova/connectors';
import type { Usage } from '@scova/models';
import { AgentPersistenceError } from '@scova/execution/agent';
import { readSource } from '@/service/source-reader.ts';
import { type AgentSessionOptions } from '@/service/agent/session.ts';
import { digest, emptyUsage, readPage } from '@/service/agent/tool-results.ts';
import type { AgentToolCaller } from '@/service/agent/tool-call.ts';

export function createAgentTools(
    { repository, context, bundle }: Pick<AgentSessionOptions, 'repository' | 'context' | 'bundle'>,
    currentUsage: Usage,
    call: AgentToolCaller,
): AgentTools {
    const tools: AgentTools = {
        providerReads: bundle.providerReads ?? bundle.searchProvider === 'api',
        search: (operationKey, query, searchOptions = {}) => {
            const language = searchLanguage(searchOptions);
            return context.conversation?.operation === 'revise'
                ? Promise.reject(new ConnectorError('configuration', '报告修订禁止联网搜索'))
                : call<SearchResponse>(
                      operationKey,
                      'search',
                      language ? { query, language } : query,
                      { ...emptyUsage(), ...bundle.search.tokenReservation, searches: 1 },
                      (options) =>
                          bundle.search.search(query, {
                              ...options,
                              ...(language ? { language } : {}),
                          }),
                      (response) => {
                          if (
                              response.kind !== 'search_results' ||
                              response.mode !== context.mode ||
                              response.query !== query ||
                              !Array.isArray(response.results) ||
                              !response.coverage
                          )
                              throw new AgentPersistenceError('INVALID_TOOL_RESULT');
                          if (bundle.search.tokenReservation) {
                              const usage = response.usage;
                              const limits = bundle.search.tokenReservation;
                              if (
                                  !usage ||
                                  !Number.isSafeInteger(usage.inputTokens) ||
                                  !Number.isSafeInteger(usage.outputTokens) ||
                                  usage.inputTokens < 0 ||
                                  usage.outputTokens < 0 ||
                                  usage.inputTokens > limits.inputTokens ||
                                  usage.outputTokens > limits.outputTokens ||
                                  usage.estimated !== false
                              )
                                  throw new ConnectorError(
                                      'budget_exceeded',
                                      '内置搜索用量缺失或超出预留',
                                  );
                          }
                      },
                  );
        },
        read: (operationKey, url) =>
            call<ReadPage>(
                operationKey,
                'read',
                url,
                { ...emptyUsage(), pages: 1 },
                async (options) => {
                    if (context.conversation?.operation === 'revise') {
                        const sources = context.conversation.sources.filter((s) => s.url === url);
                        if (!sources.length)
                            throw new ConnectorError('configuration', '修订来源不在冻结报告内');
                        await options.beforeAttempt?.('read');
                        const text = [...new Set(sources.map((s) => s.text))].join('\n\n');
                        return {
                            kind: 'read_page',
                            mode: context.mode,
                            originalUrl: url,
                            fetchedUrl: url,
                            url,
                            title: sources[0].title,
                            text,
                            contentHash: digest(text),
                            extractionVersion: 'scova-report-evidence-v1',
                            collectedAt: sources[0].observedAt,
                            truncated: true,
                            untrusted: true,
                        };
                    }
                    const saved = await repository.searchPage?.(url);
                    let page: ReadPage | undefined;
                    if (saved) {
                        try {
                            const checked = readPage(saved, context.mode);
                            if (
                                normalizeUrl(checked.originalUrl) === normalizeUrl(url) &&
                                normalizeUrl(checked.url) === normalizeUrl(url)
                            )
                                page = checked;
                        } catch {
                            /* Invalid bodies use the selected provider's read adapter. */
                        }
                    }
                    return readSource(url, page, bundle.reader, options);
                },
                (page) => {
                    readPage(page, context.mode);
                },
            ),
        model: (operationKey, input: AgentModelInput) => {
            const effective = {
                ...input,
                maxInputTokens: Math.min(input.maxInputTokens, estimateModelInputTokens(input)),
                maxOutputTokens: Math.max(
                    1,
                    Math.min(
                        input.maxOutputTokens,
                        context.budget.maxOutputTokens - currentUsage.outputTokens,
                    ),
                ),
            };
            const comparison = operationKey.startsWith('compare-facts');
            return call<AgentModelResponse>(
                operationKey,
                'model',
                input,
                {
                    ...emptyUsage(),
                    inputTokens: effective.maxInputTokens,
                    outputTokens: effective.maxOutputTokens,
                },
                async (options) => {
                    const response = await bundle.model.generateStructured(effective, options);
                    return {
                        ...response,
                        ...(comparison ? { sourceCoverage: comparisonSourceCoverage(input) } : {}),
                        ...(input.researchPolicy
                            ? { researchPolicy: structuredClone(input.researchPolicy) }
                            : {}),
                    };
                },
                (result, reused) => {
                    const limits = reused ? context.budget : effective;
                    if (
                        result.mode !== context.mode ||
                        !result.usage ||
                        !Number.isSafeInteger(result.usage.inputTokens) ||
                        !Number.isSafeInteger(result.usage.outputTokens) ||
                        result.usage.inputTokens < 0 ||
                        result.usage.outputTokens < 0 ||
                        result.usage.inputTokens > limits.maxInputTokens ||
                        result.usage.outputTokens > limits.maxOutputTokens ||
                        typeof result.usage.estimated !== 'boolean'
                    )
                        throw new ConnectorError('budget_exceeded', '模型用量不合法或超出预留');
                },
            ).then((response) =>
                comparison && response.sourceCoverage === undefined
                    ? { ...response, sourceCoverage: null }
                    : response,
            );
        },
    };

    return tools;
}
