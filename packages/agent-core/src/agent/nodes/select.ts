import { plannedRequirements } from '../../report-artifacts.ts';
import { unsupportedReadCandidate, unsupportedSearchReadCandidate } from '../../read-candidates.ts';
import { selectedOutputFormats } from '@scova/models';
import { searchRelevance, normalizeUrl } from '@scova/connectors';
import { researchWindow, scopedQuery } from '../../research-context.ts';
import {
    boundedRecoveryQuery,
    confirmsRequestedVersion,
    matchesQueryVersion,
    matchesSiteModule,
    matchesRetrievalTarget,
    objectRecoveryQuery,
    relaxSitePath,
    retrievalTargets,
} from '../../search-recovery.ts';
import { baselineReady } from '../../comparison.ts';
import { feedbackSelections } from '../../feedback.ts';
import { frozenRequirements } from '../claims.ts';
import { initialReadLimit } from '../../gap-loop.ts';
import {
    type Query,
    type Selection,
    type ResearchState,
    MAX_QUERIES,
    MAX_PAGES,
    unique,
    allowed,
} from '../state.ts';
import type { AgentRuntime } from '../runtime.ts';

export function selectNode(rt: AgentRuntime) {
    const { context, deps, questions } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (context.conversation?.operation === 'revise') {
            state.selections = [...new Set(context.conversation.sources.map((s) => s.url))]
                .slice(0, context.budget.maxPages)
                .map((url) => ({ url, questionIds: questions.map((q) => q.id) }));
            return state;
        }
        const selected = new Map<string, Selection>();
        const targets = retrievalTargets(
            plannedRequirements(
                state.planningExtraction?.response.data,
                selectedOutputFormats(context.config),
                questions,
                false,
                (state.coveragePolicy ?? 0) >= 2,
            ) ?? [],
        );
        const explicitTask = `${context.config.topic} ${context.config.goal} ${context.config.focusPoints.join(' ')}`;
        const originalQuery = (query: string) =>
            state.queries.find((item) => {
                const relaxed = relaxSitePath(item.query);
                return relaxed && scopedQuery(relaxed, context) === query;
            })?.query ?? query;
        const providerPageUrls = new Set(state.providerPageUrls ?? []);
        const hasProviderPage = (url: string) =>
            deps.tools.providerReads || providerPageUrls.has(normalizeUrl(url));
        if (baselineReady(context))
            for (const page of context.baseline!.manifest!.pages) {
                if (unsupportedReadCandidate(page.url) && !hasProviderPage(page.url))
                    state.gaps.push(
                        `冻结基线来源是当前网页读取器不支持的文档或附件，未消耗读取预算，不能完整比较：${page.url}`,
                    );
                else if (allowed(context, page.url))
                    selected.set(page.url, {
                        url: page.url,
                        questionIds: questions.map((q) => q.id),
                    });
                else state.gaps.push('冻结基线来源不再符合当前来源范围，不能完整比较');
            }
        for (const preferred of context.config.sourcePreferences.preferredUrls)
            if (unsupportedReadCandidate(preferred) && !hasProviderPage(preferred))
                state.gaps.push(
                    `优先来源是当前网页读取器不支持的文档或附件，未消耗读取预算；请提供公开正文网页：${preferred}`,
                );
            else if (allowed(context, preferred))
                selected.set(preferred, {
                    url: preferred,
                    questionIds: questions.map((question) => question.id),
                });
        const unsupported = new Set<string>();
        for (const search of state.searches)
            for (const result of search.response.results) {
                if (
                    typeof result.originalUrl !== 'string' ||
                    typeof result.url !== 'string' ||
                    result.kind !== 'search_snippet' ||
                    !allowed(context, result.url) ||
                    !allowed(context, result.originalUrl)
                ) {
                    state.gaps.push('来源因安全或来源偏好限制被排除');
                    continue;
                }
                if (
                    unsupportedSearchReadCandidate(
                        result,
                        hasProviderPage(result.url) || hasProviderPage(result.originalUrl),
                    )
                ) {
                    unsupported.add(normalizeUrl(result.url));
                    continue;
                }
                if (
                    !matchesQueryVersion(explicitTask, result) ||
                    !matchesQueryVersion(search.query.query, result)
                ) {
                    (state.notes ??= []).push(
                        '已跳过明确属于其他版本的候选；未将其作为请求版本的原文',
                    );
                    continue;
                }
                if (!matchesSiteModule(originalQuery(search.query.query), result)) {
                    (state.notes ??= []).push(
                        '已跳过精确文档查询返回的其他模块；继续查找请求模块的原文',
                    );
                    continue;
                }
                if (
                    targets.length &&
                    !targets.some((target) => matchesRetrievalTarget(target, result)) &&
                    searchRelevance(context.config.topic, result) <= 0
                )
                    continue;
                const canonicalUrl = normalizeUrl(result.url);
                const previous = selected.get(canonicalUrl);
                if (previous)
                    previous.questionIds = unique([
                        ...previous.questionIds,
                        ...search.query.questionIds,
                    ]);
                else
                    selected.set(canonicalUrl, {
                        url: result.originalUrl,
                        questionIds: search.query.questionIds,
                    });
            }
        if (unsupported.size)
            (state.notes ??= []).push(
                `已跳过 ${unsupported.size} 个当前网页读取器不支持的文档或附件候选，未占用正文读取预算，继续选择可读取来源`,
            );
        const limit = Math.min(
            MAX_PAGES,
            context.budget.maxPages,
            state.answerSupplement?.readLimit ??
                (state.gapLoopPolicy
                    ? initialReadLimit(context.budget.maxPages)
                    : state.coveragePolicy && context.budget.maxPages >= 6
                      ? context.budget.maxPages - 4
                      : MAX_PAGES),
        );
        const ranked = feedbackSelections(
            context,
            [...selected.values()],
            (url) =>
                allowed(context, url) && (!unsupportedReadCandidate(url) || hasProviderPage(url)),
        );
        if (ranked.length > limit) {
            if (state.softEvidence)
                state.notes!.push('候选来源超过正文读取预算，仅根据本次已读取材料作答');
            else state.gaps.push('候选来源超过正文读取预算，部分来源尚未读取');
        }
        const attempted = state.selections.slice(0, state.readIndex);
        const seen = new Set(attempted.map((item) => normalizeUrl(item.url)));
        const priority = new Set(
            [
                ...context.config.sourcePreferences.preferredUrls,
                ...(baselineReady(context)
                    ? context.baseline!.manifest!.pages.map((p) => p.url)
                    : []),
            ].map((url) => normalizeUrl(url)),
        );
        const scores = new Map<string, number>();
        const window = researchWindow(context);
        for (const search of state.searches)
            for (const source of search.response.results) {
                const date = `${source.title} ${source.snippet} ${source.url}`.match(
                    /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/,
                )?.[0];
                // Dates in snippets only affect selection, never publication verification.
                const dateScore =
                    date && window.start && window.end
                        ? date >= window.start.slice(0, 10) && date <= window.end.slice(0, 10)
                            ? 2
                            : -2
                        : 0;
                const score = searchRelevance(context.config.topic, source) + dateScore;
                scores.set(
                    normalizeUrl(source.url),
                    Math.max(scores.get(normalizeUrl(source.url)) ?? -Infinity, score),
                );
            }
        const remaining: Selection[] = ranked
            .filter((item) => !seen.has(normalizeUrl(item.url)))
            .filter(
                (item) =>
                    priority.has(normalizeUrl(item.url)) ||
                    (scores.get(normalizeUrl(item.url)) ?? 0) >= 0,
            );
        const covered = new Set(
            state.pages
                .filter(
                    (p) =>
                        searchRelevance(context.config.topic, {
                            title: p.title,
                            snippet: p.text.slice(0, 3000),
                            url: p.url,
                        }) > 0,
                )
                .flatMap((p) =>
                    p.questionIds.filter(
                        (id) =>
                            !state.softEvidence ||
                            searchRelevance(questions.find((q) => q.id === id)?.text ?? '', {
                                title: p.title,
                                snippet: p.text,
                                url: p.url,
                            }) > 0,
                    ),
                ),
        );
        const domainCounts = new Map<string, number>();
        const failedDomains = new Map<string, number>();
        for (const [index, item] of attempted.entries())
            if (!state.pages.some((p) => p.id === `read-${index}`)) {
                const host = new URL(item.url).hostname;
                failedDomains.set(host, (failedDomains.get(host) ?? 0) + 1);
            }
        const questionCounts = new Map<string, number>();
        const count = (item: Selection) => {
            const host = new URL(item.url).hostname;
            domainCounts.set(host, (domainCounts.get(host) ?? 0) + 1);
            for (const id of item.questionIds)
                questionCounts.set(id, (questionCounts.get(id) ?? 0) + 1);
        };
        attempted.forEach(count);
        const diversified: Selection[] = [];
        const obligations = state.knowledgeFirstPolicy ? frozenRequirements(state) : [];
        const verificationPriority = (item: Selection) =>
            Math.max(
                0,
                ...obligations
                    .filter(
                        (r) =>
                            r.required && r.questionIds.some((id) => item.questionIds.includes(id)),
                    )
                    .map((r) =>
                        r.verification === 'current' || r.verification === 'exact'
                            ? 10
                            : r.verification === 'source_required'
                              ? 8
                              : state.modelDraftTargets?.includes(r.id)
                                ? 1
                                : 4,
                    ),
            );
        while (remaining.length && attempted.length + diversified.length < limit) {
            const value = (item: Selection) =>
                verificationPriority(item) +
                (state.answerSupplement &&
                item.questionIds.includes(state.answerSupplement.questionId)
                    ? 100
                    : 0) +
                (priority.has(normalizeUrl(item.url)) ? 1000 : 0) +
                item.questionIds.filter((id) => !covered.has(id)).length * 5 +
                (scores.get(normalizeUrl(item.url)) ?? 0) -
                (failedDomains.get(new URL(item.url).hostname) ?? 0) * 30 -
                (domainCounts.get(new URL(item.url).hostname) ?? 0) * 3 -
                Math.min(...item.questionIds.map((id) => questionCounts.get(id) ?? 0), 20) * 2;
            remaining.sort((a, b) => value(b) - value(a));
            const item = remaining.shift()!;
            item.reason = priority.has(normalizeUrl(item.url)) ? 'priority' : 'topic_and_coverage';
            diversified.push(item);
            count(item);
        }
        state.selections = [...attempted, ...diversified];
        const missing = questions.filter((q) => !covered.has(q.id));
        const missingTargets = targets.filter(
            (target) =>
                !state.pages.some(
                    (p) =>
                        matchesRetrievalTarget(target, p) &&
                        confirmsRequestedVersion(explicitTask, p),
                ),
        );
        if (
            context.mode === 'live' &&
            !state.answerSupplement &&
            !state.coveragePolicy &&
            !state.searchBlocked &&
            !state.adaptiveSearchDisabled &&
            context.usage.searches < context.budget.maxSearches &&
            (state.readIndex >= 3 || !diversified.length) &&
            (missing.length || missingTargets.length) &&
            (state.supplementalSearches ?? 0) < 2 &&
            state.queries.length < Math.min(MAX_QUERIES, context.budget.maxSearches) &&
            state.readIndex < limit
        ) {
            const ordinal = state.supplementalSearches ?? 0;
            const question = missing[ordinal % missing.length] ?? questions[0]!;
            const topic = /agent|智能体/i.test(context.config.topic)
                ? 'AI agent architecture reasoning acting'
                : context.config.topic;
            let recovery: Query | undefined;
            for (const search of state.searches) {
                const relaxed = relaxSitePath(search.query.query);
                if (
                    !relaxed ||
                    state.queries.some((item) => item.query === scopedQuery(relaxed, context))
                )
                    continue;
                const usable = search.response.results.some(
                    (source) =>
                        allowed(context, source.url) &&
                        allowed(context, source.originalUrl) &&
                        matchesQueryVersion(explicitTask, source) &&
                        matchesQueryVersion(search.query.query, source) &&
                        matchesSiteModule(originalQuery(search.query.query), source) &&
                        !unsupportedSearchReadCandidate(
                            source,
                            hasProviderPage(source.url) || hasProviderPage(source.originalUrl),
                        ) &&
                        (searchRelevance(search.query.query.replace(/\bsite:\S+/g, ''), source) >
                            0 ||
                            targets.some((target) => matchesRetrievalTarget(target, source))),
                );
                if (!usable) {
                    recovery = {
                        query: scopedQuery(relaxed, context),
                        questionIds: search.query.questionIds,
                    };
                    break;
                }
            }
            if (!recovery) {
                for (const target of missingTargets) {
                    const query = scopedQuery(
                        objectRecoveryQuery(context.config.topic, explicitTask, target, targets),
                        context,
                    );
                    if (!state.queries.some((item) => item.query === query)) {
                        recovery = { query, questionIds: target.questionIds };
                        break;
                    }
                }
            }
            const query = boundedRecoveryQuery(
                scopedQuery(
                    topic +
                        ' ' +
                        question.text +
                        (ordinal ? ' 官方文档 原始资料' : ' 原理 适用条件'),
                    context,
                ),
            );
            recovery ??= { query, questionIds: [question.id] };
            if (!state.queries.some((item) => item.query === recovery.query)) {
                state.supplementalSearches = ordinal + 1;
                state.queries.push(recovery);
            }
        }
        return state;
    };
}
